import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { bookAppointment } from '../appointments/index.js';
import {
  cancelFollowUp,
  dayWithin,
  findFollowUp,
  insertFollowUp,
  listFollowUps,
  setFollowUpAppointment,
  type FollowUpRow,
} from './follow-up-repository.js';
import { encounterFor, FEATURE, invalid, uniqueRefusal, userIdOf, visibilityFor } from './http.js';
import { practisingDoctor } from './repository.js';
import {
  EncounterParams,
  FollowUp,
  FollowUpBook,
  FollowUpCancel,
  FollowUpCreate,
  FollowUpListQuery,
  FollowUpPage,
  FollowUpParams,
  FOLLOW_UP_DAYS_AHEAD,
  FOLLOW_UP_NOTE_MAX,
  PageQuery,
  REASON_MAX,
  type FollowUpStateValue,
} from './schemas.js';

const READ = 'followUp:read';
const CREATE = 'followUp:create';
const BOOK = 'appointment:create';

const notFound = () => new HttpError(404, 'follow_up_not_found', 'No such follow-up');

const optional = <Key extends string, Value>(key: Key, value: Value | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

export const followUpView = (row: FollowUpRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  doctorId: row.doctor_id,
  doctorName: row.doctor_name,
  dueOn: row.due_on,
  ...optional('note', row.note),
  state: row.state,
  ...optional('appointmentId', row.appointment_id),
  ...optional('appointmentStartsAt', row.appointment_starts_at?.toISOString() ?? null),
  createdAt: row.created_at.toISOString(),
  createdByName: row.created_by_name,
  ...optional('bookedAt', row.booked_at?.toISOString() ?? null),
  ...optional('cancelledAt', row.cancelled_at?.toISOString() ?? null),
  ...optional('cancelReason', row.cancel_reason),
  version: row.version,
});

const page = (result: Awaited<ReturnType<typeof listFollowUps>>, request: FastifyRequest) => {
  if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
  for (const row of result.rows) request.audit('read', 'follow_up', row.id);
  return {
    items: result.rows.map(followUpView),
    nextCursor: result.nextCursor,
    ...(result.total === undefined ? {} : { total: result.total }),
  };
};

const SCOPE =
  ' The encounter decides who reaches it: one of another hospital, or outside the scope the caller holds followUp:read with, is 404 as one that does not exist.';
const NAMES =
  ' Each follow-up names its patient (name and MRN), so whoever books it knows whom to call in: followUp:read gives that.';

/** Follow-ups (#88): when the patient should come back, and the appointment that books it. */
export const followUpRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/follow-ups',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listFollowUps',
        tags: ['clinical'],
        description:
          'The follow-up due list: the follow-ups the caller may see, the soonest due first, in one state (`due` for those to book), due between two days at the hospital, of one doctor, or any of those together. Within the scope the caller holds followUp:read with, read from the encounter as for encounter:read (`own`: the encounters the caller attends); one outside it is left out, never refused. A list nobody types patient facts into, so a GET. Requires followUp:read and the clinical feature flag. Every follow-up of a page is audited. `total` comes with the first page only, and only with a `doctorId`: a whole hospital is not counted on every first page.' +
          NAMES,
        querystring: FollowUpListQuery,
        response: { 200: ref(FollowUpPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { state, dueFrom, dueTo, doctorId, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      return page(
        await listFollowUps(
          request.txClient,
          {
            ...(state === undefined ? {} : { state: state as FollowUpStateValue }),
            ...(dueFrom === undefined ? {} : { dueFrom }),
            ...(dueTo === undefined ? {} : { dueTo }),
            ...(doctorId === undefined ? {} : { doctorId }),
            ...(cursor === undefined ? {} : { cursor }),
            limit,
          },
          visibilityFor(request, READ),
        ),
        request,
      );
    },
  );

  app.get(
    '/encounters/:encounterId/follow-ups',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listEncounterFollowUps',
        tags: ['clinical'],
        description:
          'The encounter’s follow-ups, cancelled ones included: at most one that is not cancelled. Requires followUp:read and the clinical feature flag. Every follow-up of a page is audited.' +
          SCOPE +
          NAMES,
        params: EncounterParams,
        querystring: PageQuery,
        response: { 200: ref(FollowUpPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const encounter = await encounterFor(request, request.params.encounterId, READ);
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      return page(
        await listFollowUps(
          request.txClient,
          { encounterId: encounter.id, ...(cursor === undefined ? {} : { cursor }), limit },
          visibilityFor(request, READ),
        ),
        request,
      );
    },
  );

  /**
   * A follow-up the caller reaches with `permission` (followUp:read unless said), locked when
   * asked: the scope is in the same query, so nothing outside it is locked.
   */
  async function followUpFor(
    request: FastifyRequest,
    id: string,
    { forUpdate = false, permission = READ }: { forUpdate?: boolean; permission?: Permission } = {},
  ) {
    const row = await findFollowUp(request.txClient, id, visibilityFor(request, permission), {
      forUpdate,
    });
    if (!row) throw notFound();
    return row;
  }

  app.post(
    '/encounters/:encounterId/follow-ups',
    {
      config: {
        permissions: [READ, CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createFollowUp',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks the patient of an open encounter (409 `encounter_not_open` otherwise) to come back on a day, from today to a year ahead at the hospital (422 `outside_window`), to a doctor: the one named, else the encounter’s (400 when it has none). A doctor who does not practise here is 422 `unknown_doctor`. One follow-up per encounter that is not cancelled (409 `follow_up_exists`): cancel it to set another. It is then due, and booking it makes the appointment. The Idempotency-Key header is required: a repeat sets nothing and answers with the follow-up as it is now. Requires followUp:create and followUp:read, and the clinical feature flag. Audited, and emits `followup.created` through the outbox with ids and the day, never the note.' +
          SCOPE,
        params: EncounterParams,
        body: ref(FollowUpCreate),
        response: { 201: ref(FollowUp), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const set = request.idempotentId ? await followUpFor(request, request.idempotentId) : null;
        if (!set) throw notFound();
        request.audit('read', 'follow_up', set.id);
        return reply.status(201).send(followUpView(set));
      }
      const body = request.body as FollowUpCreate;
      const userId = userIdOf(request);
      const note = tidyLinesOptional(body.note, FOLLOW_UP_NOTE_MAX);
      const encounter = await encounterFor(request, request.params.encounterId, CREATE, {
        open: true,
      });
      const doctorId = body.doctorId ?? encounter.attending_doctor_id;
      if (doctorId === null) throw invalid('A doctor is needed');
      const doctor = await practisingDoctor(request.txClient, doctorId, { scope: 'all', userId });
      if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
      if (!(await dayWithin(request.txClient, body.dueOn, FOLLOW_UP_DAYS_AHEAD))) {
        throw new HttpError(422, 'outside_window', 'Not a day from today to a year ahead');
      }
      let id: string;
      try {
        id = await insertFollowUp(
          request.txClient,
          {
            encounterId: encounter.id,
            patientId: encounter.patient_id,
            doctorId: doctor.id,
            dueOn: body.dueOn,
            note,
          },
          userId,
        );
      } catch (error) {
        throw uniqueRefusal(error, {
          follow_ups_one_per_encounter: new HttpError(
            409,
            'follow_up_exists',
            'The encounter has a follow-up',
          ),
        });
      }
      request.idempotentId = id;
      request.audit('create', 'follow_up', id);
      await request.emit('followup.created', id, {
        followUpId: id,
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        doctorId: doctor.id,
        dueOn: body.dueOn,
      });
      return reply.status(201).send(followUpView(await followUpFor(request, id)));
    },
  );

  /**
   * The shape both changes share: a repeat answers with the follow-up as it is now; otherwise it
   * is locked, within the caller's scope, at the version the change was made from, and due.
   */
  async function changeFollowUp(
    request: FastifyRequest<{ Params: { followUpId: string } }>,
    reply: FastifyReply,
    permission: Permission,
    version: number,
    change: (row: FollowUpRow) => Promise<void>,
  ) {
    const id = request.params.followUpId;
    if (request.replayOf === null) {
      const row = await followUpFor(request, id, { forUpdate: true, permission });
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The follow-up has changed since it was read');
      }
      if (row.state !== 'due') {
        throw new HttpError(409, 'invalid_transition', `The follow-up is ${row.state}`);
      }
      await change(row);
      request.audit('update', 'follow_up', row.id);
    }
    const now = await followUpFor(request, id);
    if (request.replayOf !== null) request.audit('read', 'follow_up', now.id);
    return reply.status(200).send(followUpView(now));
  }

  const CHANGE =
    ' Only a due follow-up (409 `invalid_transition` for one booked, attended or cancelled); one whose appointment was cancelled or missed is due again. The `version` must be the current one, or 409 `conflict`. Allowed after the encounter closed. The Idempotency-Key header is required: a repeat changes nothing and answers with the follow-up as it is now. Audited.' +
    SCOPE;

  app.post(
    '/follow-ups/:followUpId/book',
    {
      config: {
        permissions: [READ, BOOK],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'bookFollowUp',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Books a due follow-up as an appointment of its patient, with its doctor or another one, at one of the doctor’s free slots, and links the two in one transaction: the follow-up names the appointment. The booking follows `POST /appointments` (its scope of appointment:create, and its refusals: 422 `unknown_doctor`, `outside_hours`, 409 `slot_taken`, `patient_overlap`), audits it and emits `appointment.created`, then `followup.booked`. Requires followUp:read and appointment:create, and both the clinical and the appointments feature flags (403 `feature_disabled`).' +
          CHANGE,
        params: FollowUpParams,
        body: ref(FollowUpBook),
        response: { 200: ref(FollowUp), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      // The guard checks the clinical switch only: booking is the appointments module's too.
      if ((await request.access.policy())?.features.appointments !== true) {
        throw new HttpError(403, 'feature_disabled', 'Appointments are switched off');
      }
      const body = request.body as FollowUpBook;
      // Booking is the desk's: within the scope it reads follow-ups with.
      return changeFollowUp(request, reply, READ, body.version, async (row) => {
        const appointmentId = await bookAppointment(
          request,
          {
            patientId: row.patient_id,
            doctorId: body.doctorId ?? row.doctor_id,
            startsAt: body.startsAt,
            reason: null,
          },
          visibilityFor(request, BOOK),
        );
        await setFollowUpAppointment(request.txClient, row.id, appointmentId, userIdOf(request));
        await request.emit('followup.booked', row.id, {
          followUpId: row.id,
          encounterId: row.encounter_id,
          patientId: row.patient_id,
          appointmentId,
        });
      });
    },
  );

  app.post(
    '/follow-ups/:followUpId/cancel',
    {
      config: {
        permissions: [READ, CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'cancelFollowUp',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels a follow-up with a reason: the patient need not come back. It stays, final, and the encounter may set another. A booked one is refused: cancel its appointment first. Requires followUp:read and followUp:create, and the clinical feature flag; the follow-up is found within the scope of followUp:create. Emits `followup.cancelled` through the outbox.' +
          CHANGE,
        params: FollowUpParams,
        body: ref(FollowUpCancel),
        response: { 200: ref(FollowUp), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as FollowUpCancel;
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw invalid('A reason is needed');
      return changeFollowUp(request, reply, CREATE, body.version, async (row) => {
        await cancelFollowUp(request.txClient, row.id, reason, userIdOf(request));
        await request.emit('followup.cancelled', row.id, {
          followUpId: row.id,
          encounterId: row.encounter_id,
          patientId: row.patient_id,
        });
      });
    },
  );
};
