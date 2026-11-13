import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import type { Stay } from '../admissions/index.js';
import {
  CARE_SCHEMAS,
  CarePlan,
  CarePlanClose,
  CarePlanCreate,
  CarePlanPage,
  CarePlanTaskCreate,
  CarePlanTaskDone,
  FluidQuery,
  FluidParams,
  FluidTotals,
  FluidTotalsQuery,
  GOAL_MAX,
  INTAKE_KINDS,
  PlanParams,
  PROBLEM_MAX,
  TASK_MAX,
  TaskParams,
  WardFluid,
  WardFluidCorrect,
  WardFluidCreate,
  WardFluidPage,
} from './care-schemas.js';
import {
  closeCarePlan,
  completeCarePlanTask,
  findCarePlan,
  findCarePlanTask,
  findWardFluid,
  fluidTotals,
  insertCarePlan,
  insertCarePlanTask,
  insertWardFluid,
  listCarePlans,
  listWardFluids,
  tasksOfPlans,
  type CarePlanRow,
  type CarePlanTaskRow,
  type WardFluidRow,
} from './care-repository.js';
import {
  invalid,
  notFuture,
  openStay,
  page,
  refusedBy,
  stayEvent,
  stayFor,
  stayNotFound,
  stayRefusal,
  userIdOf,
} from './routes.js';
import { AdmissionParams, PageQuery, REASON_MAX } from './schemas.js';

const FEATURE = 'nursing';
const FLUID_READ = 'fluidBalance:read';
const FLUID_RECORD = 'fluidBalance:record';
const PLAN_READ = 'carePlan:read';
const PLAN_WRITE = 'carePlan:write';

const iso = (value: Date) => value.toISOString();
const isIntake = (kind: string) => (INTAKE_KINDS as readonly string[]).includes(kind);
/** The longest window a total is asked for: a day and a bit, so a shift or a day, never a month. */
const MAX_WINDOW_MS = 36 * 3_600_000;

const fluidView = (row: WardFluidRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  admissionId: row.admission_id,
  direction: row.direction,
  kind: row.kind,
  amountMl: row.amount_ml,
  observedAt: iso(row.observed_at),
  recordedAt: iso(row.recorded_at),
  recordedById: row.recorded_by,
  recordedByName: row.recorded_by_name,
  ...(row.corrects_id === null ? {} : { correctsId: row.corrects_id }),
  ...(row.correction_reason === null ? {} : { correctionReason: row.correction_reason }),
  ...(row.corrected_by_id === null ? {} : { correctedById: row.corrected_by_id }),
});

const taskView = (row: CarePlanTaskRow) => ({
  id: row.id,
  description: row.description,
  ...(row.due_at === null ? {} : { dueAt: iso(row.due_at) }),
  ...(row.done_at === null ? {} : { doneAt: iso(row.done_at) }),
  ...(row.done_by === null ? {} : { doneById: row.done_by }),
  ...(row.done_by_name === null ? {} : { doneByName: row.done_by_name }),
  ...(row.done_note === null ? {} : { doneNote: row.done_note }),
});

const planView = (row: CarePlanRow, tasks: CarePlanTaskRow[]) => ({
  id: row.id,
  tenantId: row.tenant_id,
  admissionId: row.admission_id,
  problem: row.problem,
  ...(row.goal === null ? {} : { goal: row.goal }),
  status: row.status,
  createdAt: iso(row.created_at),
  createdById: row.created_by,
  createdByName: row.created_by_name,
  ...(row.closed_at === null ? {} : { closedAt: iso(row.closed_at) }),
  tasks: tasks.filter((task) => task.plan_id === row.id).map(taskView),
});

const tidy = (value: string, max: number, what: string): string => {
  const text = tidyWithin(value, max);
  if (text === '') throw invalid(`${what} says something`);
  return text;
};

const optionalDate = (value: string | undefined, field: string): Date | undefined => {
  if (value === undefined) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid(`${field} is not a time`);
  return at;
};

export const careRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of CARE_SCHEMAS) app.addSchema(schema);

  const createConfig = (permissions: Permission[]) =>
    ({ permissions, feature: FEATURE, idempotent: { body: 'none', required: true } }) as const;
  const writeConfig = (permissions: Permission[]) => ({ permissions, feature: FEATURE }) as const;

  const REPLAY =
    ' The Idempotency-Key header is required: the same key records nothing again and answers with the record as it is now.';
  const SCOPE =
    ' A stay outside the scope the caller holds the permission with, or another hospital’s, answers 404 `admission_not_found`. A stay that has ended takes no new record (409 `admission_not_open`).';

  // --- fluid intake and output -----------------------------------------------------------------

  app.get(
    '/admissions/:admissionId/fluids',
    {
      config: { permissions: [FLUID_READ], feature: FEATURE },
      schema: {
        operationId: 'listWardFluids',
        tags: ['nursing'],
        description: `The fluid intake and output entries of the stay by the time observed, newest first, optionally between \`from\` (included) and \`to\` (excluded). Corrections and the entries they correct are both listed.${SCOPE} Every row is audited as a read.`,
        params: AdmissionParams,
        querystring: FluidQuery,
        response: { 200: ref(WardFluidPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, FLUID_READ);
      const result = await listWardFluids(
        request.txClient,
        stay.id,
        {
          from: optionalDate(request.query.from, 'from'),
          to: optionalDate(request.query.to, 'to'),
        },
        {
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          limit: page(request.query.limit),
        },
      );
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of result.rows) request.audit('read', 'ward_fluid', row.id);
      return { items: result.rows.map(fluidView), nextCursor: result.nextCursor };
    },
  );

  app.get(
    '/admissions/:admissionId/fluids/totals',
    {
      config: { permissions: [FLUID_READ], feature: FEATURE },
      schema: {
        operationId: 'getFluidTotals',
        tags: ['nursing'],
        description: `Intake, output and their balance in millilitres between two instants (\`from\` included, \`to\` excluded, at most 36 hours apart, 400 \`validation_failed\` otherwise). The web app asks once for each shift of the day. An entry that was corrected counts as its correction.${SCOPE} Audited as a read of the stay's balance.`,
        params: AdmissionParams,
        querystring: FluidTotalsQuery,
        response: { 200: ref(FluidTotals), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, FLUID_READ);
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
        throw invalid('to is after from');
      }
      if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw invalid('The window is too long');
      const totals = await fluidTotals(request.txClient, stay.id, from, to);
      request.audit('read', 'ward_fluid', stay.id);
      return {
        from: iso(from),
        to: iso(to),
        intakeMl: totals.intake,
        outputMl: totals.output,
        balanceMl: totals.intake - totals.output,
        entries: totals.entries,
      };
    },
  );

  async function fluidReplay(request: FastifyRequest, reply: FastifyReply) {
    const row = request.idempotentId
      ? await findWardFluid(request.txClient, request.idempotentId)
      : null;
    if (!row) throw stayNotFound();
    await stayFor(request, row.admission_id, FLUID_RECORD);
    request.audit('read', 'ward_fluid', row.id);
    return reply.status(201).send(fluidView(row));
  }

  app.post(
    '/admissions/:admissionId/fluids',
    {
      config: createConfig([FLUID_RECORD, FLUID_READ]),
      schema: {
        operationId: 'recordWardFluid',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Records fluid taken in (oral, intravenous, tube) or put out (urine, drain, vomit, stool) in whole millilitres, 1 to 5000. \`observedAt\` is now unless sent, never in the future.${SCOPE}${REPLAY} Audited; emits \`fluid.recorded\` (ids and the direction, never an amount).`,
        params: AdmissionParams,
        body: ref(WardFluidCreate),
        response: { 201: ref(WardFluid), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return fluidReplay(request, reply);
      const body = request.body as WardFluidCreate;
      const stay = await stayFor(request, request.params.admissionId, FLUID_RECORD, true);
      openStay(stay);
      const observedAt = notFuture(body.observedAt, 'observedAt');
      const direction = isIntake(body.kind) ? 'intake' : 'output';
      let id: string;
      try {
        id = await insertWardFluid(
          request.txClient,
          { ...stayEvent(stay), direction, kind: body.kind, amountMl: body.amountMl, observedAt },
          userIdOf(request),
        );
      } catch (error) {
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'ward_fluid', id);
      await request.emit('fluid.recorded', id, { fluidId: id, direction, ...stayEvent(stay) });
      const row = await findWardFluid(request.txClient, id);
      if (!row) throw new Error('fluid entry was not recorded');
      return reply.status(201).send(fluidView(row));
    },
  );

  app.post(
    '/admissions/:admissionId/fluids/:fluidId/correct',
    {
      config: createConfig([FLUID_RECORD, FLUID_READ]),
      schema: {
        operationId: 'correctWardFluid',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Corrects an entry of the stay with a new one that names it and gives a reason; the original is kept. The correction is of the same direction (422 \`direction_changed\`), is taken at the time of the one it corrects, and an entry is corrected once (422 \`already_corrected\`). One of another stay is 404 \`fluid_not_found\`.${SCOPE}${REPLAY} Audited; emits \`fluid.recorded\`.`,
        params: FluidParams,
        body: ref(WardFluidCorrect),
        response: { 201: ref(WardFluid), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return fluidReplay(request, reply);
      const body = request.body as WardFluidCorrect;
      const stay = await stayFor(request, request.params.admissionId, FLUID_RECORD, true);
      openStay(stay);
      const corrected = await findWardFluid(request.txClient, request.params.fluidId, stay.id);
      if (!corrected) throw new HttpError(404, 'fluid_not_found', 'No such entry');
      if (corrected.corrected_by_id !== null) {
        throw new HttpError(422, 'already_corrected', 'The entry is already corrected');
      }
      const direction = isIntake(body.kind) ? 'intake' : 'output';
      if (direction !== corrected.direction) {
        throw new HttpError(422, 'direction_changed', 'A correction keeps intake or output');
      }
      const reason = tidy(body.reason, REASON_MAX, 'The reason');
      let id: string;
      try {
        id = await insertWardFluid(
          request.txClient,
          {
            ...stayEvent(stay),
            direction,
            kind: body.kind,
            amountMl: body.amountMl,
            observedAt: corrected.observed_at,
            correctsId: corrected.id,
            correctionReason: reason,
          },
          userIdOf(request),
        );
      } catch (error) {
        if (refusedBy(error, 'ward_fluids_corrected_once')) {
          throw new HttpError(422, 'already_corrected', 'The entry is already corrected');
        }
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'ward_fluid', id);
      await request.emit('fluid.recorded', id, {
        fluidId: id,
        direction,
        correctsId: corrected.id,
        ...stayEvent(stay),
      });
      const row = await findWardFluid(request.txClient, id);
      if (!row) throw new Error('fluid entry was not recorded');
      return reply.status(201).send(fluidView(row));
    },
  );

  // --- care plans ------------------------------------------------------------------------------

  async function planAnswer(request: FastifyRequest, id: string) {
    const row = await findCarePlan(request.txClient, id);
    if (!row) throw new Error('care plan was not recorded');
    return planView(row, await tasksOfPlans(request.txClient, [row.id]));
  }

  /** The stay of a plan or task, within the caller's scope: a missing or foreign one is one 404. */
  async function stayOfPlan(
    request: FastifyRequest,
    admissionId: string,
    permission: Permission,
    code: 'plan_not_found' | 'task_not_found',
  ): Promise<Stay> {
    try {
      return await stayFor(request, admissionId, permission, true);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'admission_not_found') {
        throw new HttpError(404, code, code === 'plan_not_found' ? 'No such plan' : 'No such task');
      }
      throw error;
    }
  }

  app.get(
    '/admissions/:admissionId/care-plans',
    {
      config: { permissions: [PLAN_READ], feature: FEATURE },
      schema: {
        operationId: 'listCarePlans',
        tags: ['nursing'],
        description: `The care plans of the stay, newest first, each with its tasks in the order they were added.${SCOPE} Every plan is audited as a read.`,
        params: AdmissionParams,
        querystring: PageQuery,
        response: { 200: ref(CarePlanPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, PLAN_READ);
      const result = await listCarePlans(request.txClient, stay.id, {
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        limit: page(request.query.limit),
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const tasks = await tasksOfPlans(
        request.txClient,
        result.rows.map((row) => row.id),
      );
      for (const row of result.rows) request.audit('read', 'care_plan', row.id);
      return {
        items: result.rows.map((row) => planView(row, tasks)),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.post(
    '/admissions/:admissionId/care-plans',
    {
      config: createConfig([PLAN_WRITE, PLAN_READ]),
      schema: {
        operationId: 'createCarePlan',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Starts a care plan for an admitted patient: the problem, optionally a goal and up to 20 tasks, each with an optional due time.${SCOPE}${REPLAY} Audited; emits \`careplan.created\` (ids only).`,
        params: AdmissionParams,
        body: ref(CarePlanCreate),
        response: { 201: ref(CarePlan), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const row = request.idempotentId
          ? await findCarePlan(request.txClient, request.idempotentId)
          : null;
        if (!row) throw stayNotFound();
        await stayFor(request, row.admission_id, PLAN_WRITE);
        request.audit('read', 'care_plan', row.id);
        return reply.status(201).send(await planAnswer(request, row.id));
      }
      const body = request.body as CarePlanCreate;
      const stay = await stayFor(request, request.params.admissionId, PLAN_WRITE, true);
      openStay(stay);
      const problem = tidy(body.problem, PROBLEM_MAX, 'The problem');
      const goal = body.goal === undefined ? undefined : tidy(body.goal, GOAL_MAX, 'The goal');
      const tasks = (body.tasks ?? []).map((task) => ({
        description: tidy(task.description, TASK_MAX, 'A task'),
        dueAt: optionalDate(task.dueAt, 'dueAt'),
      }));
      let id: string;
      try {
        const userId = userIdOf(request);
        id = await insertCarePlan(request.txClient, { ...stayEvent(stay), problem, goal }, userId);
        for (const task of tasks) {
          await insertCarePlanTask(
            request.txClient,
            { ...stayEvent(stay), planId: id, ...task },
            userId,
          );
        }
      } catch (error) {
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'care_plan', id);
      await request.emit('careplan.created', id, { planId: id, ...stayEvent(stay) });
      return reply.status(201).send(await planAnswer(request, id));
    },
  );

  app.post(
    '/care-plans/:planId/tasks',
    {
      config: createConfig([PLAN_WRITE, PLAN_READ]),
      schema: {
        operationId: 'addCarePlanTask',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Adds a task to a plan that is still active (409 \`plan_closed\`). A plan outside the caller scope, or another hospital’s, is 404 \`plan_not_found\`; of a stay that has ended, 409 \`admission_not_open\`.${REPLAY} Audited as an update of the plan.`,
        params: PlanParams,
        body: ref(CarePlanTaskCreate),
        response: { 201: ref(CarePlan), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const planId = request.replayOf !== null ? request.idempotentId : request.params.planId;
      const found = planId ? await findCarePlan(request.txClient, planId) : null;
      if (!found) throw new HttpError(404, 'plan_not_found', 'No such plan');
      const stay = await stayOfPlan(request, found.admission_id, PLAN_WRITE, 'plan_not_found');
      if (request.replayOf !== null) {
        // A replay of an add answers with the plan as it stands now.
        return reply.status(201).send(await planAnswer(request, found.id));
      }
      openStay(stay);
      const plan = await findCarePlan(request.txClient, found.id, { forUpdate: true });
      if (!plan) throw new HttpError(404, 'plan_not_found', 'No such plan');
      if (plan.status !== 'active') {
        throw new HttpError(409, 'plan_closed', 'The plan has ended');
      }
      const body = request.body as CarePlanTaskCreate;
      try {
        await insertCarePlanTask(
          request.txClient,
          {
            ...stayEvent(stay),
            planId: plan.id,
            description: tidy(body.description, TASK_MAX, 'A task'),
            dueAt: optionalDate(body.dueAt, 'dueAt'),
          },
          userIdOf(request),
        );
      } catch (error) {
        throw stayRefusal(error);
      }
      // Replays of an add are keyed by the plan, not by the task.
      request.idempotentId = plan.id;
      request.audit('update', 'care_plan', plan.id);
      return reply.status(201).send(await planAnswer(request, plan.id));
    },
  );

  app.post(
    '/care-plan-tasks/:taskId/done',
    {
      config: writeConfig([PLAN_WRITE, PLAN_READ]),
      schema: {
        operationId: 'completeCarePlanTask',
        tags: ['nursing'],
        description:
          'Marks a task done, with an optional note, by the caller now. A task is done once (409 `already_done`) and a plan that has ended takes no more (409 `plan_closed`). A task outside the caller scope, or another hospital’s, is 404 `task_not_found`; of a stay that has ended, 409 `admission_not_open`. Audited; emits `careplan.task_done`.',
        params: TaskParams,
        body: ref(CarePlanTaskDone),
        response: { 200: ref(CarePlan), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const found = await findCarePlanTask(request.txClient, request.params.taskId);
      if (!found) throw new HttpError(404, 'task_not_found', 'No such task');
      const stay = await stayOfPlan(request, found.admission_id, PLAN_WRITE, 'task_not_found');
      openStay(stay);
      const plan = await findCarePlan(request.txClient, found.plan_id, { forUpdate: true });
      if (!plan) throw new HttpError(404, 'task_not_found', 'No such task');
      if (plan.status !== 'active') throw new HttpError(409, 'plan_closed', 'The plan has ended');
      const task = await findCarePlanTask(request.txClient, found.id);
      if (task?.done_at) throw new HttpError(409, 'already_done', 'The task is already done');
      const body = request.body as CarePlanTaskDone;
      const note = body.note === undefined ? undefined : tidy(body.note, REASON_MAX, 'The note');
      try {
        await completeCarePlanTask(request.txClient, found.id, note, userIdOf(request));
      } catch (error) {
        throw stayRefusal(error);
      }
      request.audit('update', 'care_plan', plan.id);
      await request.emit('careplan.task_done', found.id, {
        planId: plan.id,
        taskId: found.id,
        ...stayEvent(stay),
      });
      return planAnswer(request, plan.id);
    },
  );

  app.post(
    '/care-plans/:planId/close',
    {
      config: writeConfig([PLAN_WRITE, PLAN_READ]),
      schema: {
        operationId: 'closeCarePlan',
        tags: ['nursing'],
        description:
          'Ends an active plan as completed or cancelled; it does not change again (409 `plan_closed`). A plan outside the caller scope, or another hospital’s, is 404 `plan_not_found`; of a stay that has ended, 409 `admission_not_open`. Audited; emits `careplan.closed`.',
        params: PlanParams,
        body: ref(CarePlanClose),
        response: { 200: ref(CarePlan), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const found = await findCarePlan(request.txClient, request.params.planId);
      if (!found) throw new HttpError(404, 'plan_not_found', 'No such plan');
      const stay = await stayOfPlan(request, found.admission_id, PLAN_WRITE, 'plan_not_found');
      openStay(stay);
      const plan = await findCarePlan(request.txClient, found.id, { forUpdate: true });
      if (!plan) throw new HttpError(404, 'plan_not_found', 'No such plan');
      if (plan.status !== 'active') throw new HttpError(409, 'plan_closed', 'The plan has ended');
      const { status } = request.body as CarePlanClose;
      try {
        await closeCarePlan(request.txClient, plan.id, status, userIdOf(request));
      } catch (error) {
        throw stayRefusal(error);
      }
      request.audit('update', 'care_plan', plan.id);
      await request.emit('careplan.closed', plan.id, {
        planId: plan.id,
        status,
        ...stayEvent(stay),
      });
      return planAnswer(request, plan.id);
    },
  );
};
