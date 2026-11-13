import type pg from 'pg';
import { exact, isUuid, newestFirst } from './repository.js';

/** The SQL of fluid balance and care plans, on the request's own transaction (see repository.ts). */

type Paging = { cursor?: string | undefined; limit: number };

// --- fluid balance -----------------------------------------------------------------------------

export interface WardFluidRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  direction: 'intake' | 'output';
  kind: string;
  amount_ml: number;
  observed_at: Date;
  recorded_at: Date;
  recorded_by: string;
  recorded_by_name: string;
  corrects_id: string | null;
  correction_reason: string | null;
  corrected_by_id: string | null;
  cursor_t: string;
}

const FLUIDS = `
  select x.id, x.tenant_id, x.admission_id, x.encounter_id, x.patient_id, x.direction, x.kind,
         x.amount_ml, x.observed_at, x.recorded_at, x.recorded_by,
         coalesce(u.name, '') as recorded_by_name, x.corrects_id, x.correction_reason,
         (select c.id from ward_fluids c where c.tenant_id = x.tenant_id and c.corrects_id = x.id)
           as corrected_by_id,
         ${exact('x.observed_at')} as cursor_t
  from ward_fluids x
  left join users u on u.id = x.recorded_by`;

export const listWardFluids = (
  client: pg.ClientBase,
  admissionId: string,
  filter: { from?: Date | undefined; to?: Date | undefined },
  paging: Paging,
) =>
  newestFirst<WardFluidRow>(
    client,
    FLUIDS,
    'x.observed_at',
    'x.admission_id = $1 and ($2::timestamptz is null or x.observed_at >= $2) and ($3::timestamptz is null or x.observed_at < $3)',
    [admissionId, filter.from ?? null, filter.to ?? null],
    paging,
  );

export async function findWardFluid(
  client: pg.ClientBase,
  id: string,
  admissionId?: string,
): Promise<WardFluidRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<WardFluidRow>(
    `${FLUIDS} where x.id = $1 and ($2::uuid is null or x.admission_id = $2)`,
    [id, admissionId ?? null],
  );
  return rows[0] ?? null;
}

export async function insertWardFluid(
  client: pg.ClientBase,
  entry: {
    admissionId: string;
    encounterId: string;
    patientId: string;
    direction: 'intake' | 'output';
    kind: string;
    amountMl: number;
    observedAt: Date;
    correctsId?: string;
    correctionReason?: string;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into ward_fluids (tenant_id, admission_id, encounter_id, patient_id, direction, kind,
                              amount_ml, observed_at, recorded_by, corrects_id, correction_reason)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      entry.admissionId,
      entry.encounterId,
      entry.patientId,
      entry.direction,
      entry.kind,
      entry.amountMl,
      entry.observedAt,
      userId,
      entry.correctsId ?? null,
      entry.correctionReason ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('fluid entry was not recorded');
  return id;
}

/** Intake and output between two instants; an entry that was corrected counts as its correction. */
export async function fluidTotals(
  client: pg.ClientBase,
  admissionId: string,
  from: Date,
  to: Date,
): Promise<{ intake: number; output: number; entries: number }> {
  const { rows } = await client.query<{ intake: string; output: string; entries: string }>(
    `select coalesce(sum(amount_ml) filter (where direction = 'intake'), 0) as intake,
            coalesce(sum(amount_ml) filter (where direction = 'output'), 0) as output,
            count(*) as entries
     from ward_fluids x
     where x.admission_id = $1 and x.observed_at >= $2 and x.observed_at < $3
       and not exists (select 1 from ward_fluids c
                       where c.tenant_id = x.tenant_id and c.corrects_id = x.id)`,
    [admissionId, from, to],
  );
  const row = rows[0];
  return {
    intake: Number(row?.intake ?? 0),
    output: Number(row?.output ?? 0),
    entries: Number(row?.entries ?? 0),
  };
}

// --- care plans --------------------------------------------------------------------------------

export interface CarePlanRow {
  id: string;
  tenant_id: string;
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  problem: string;
  goal: string | null;
  status: 'active' | 'completed' | 'cancelled';
  created_at: Date;
  created_by: string;
  created_by_name: string;
  closed_at: Date | null;
  cursor_t: string;
}

export interface CarePlanTaskRow {
  id: string;
  plan_id: string;
  description: string;
  due_at: Date | null;
  done_at: Date | null;
  done_by: string | null;
  done_by_name: string | null;
  done_note: string | null;
}

const PLANS = `
  select x.id, x.tenant_id, x.admission_id, x.encounter_id, x.patient_id, x.problem, x.goal,
         x.status, x.created_at, x.created_by, coalesce(u.name, '') as created_by_name,
         x.closed_at, ${exact('x.created_at')} as cursor_t
  from care_plans x
  left join users u on u.id = x.created_by`;

export const listCarePlans = (client: pg.ClientBase, admissionId: string, paging: Paging) =>
  newestFirst<CarePlanRow>(
    client,
    PLANS,
    'x.created_at',
    'x.admission_id = $1',
    [admissionId],
    paging,
  );

export async function findCarePlan(
  client: pg.ClientBase,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<CarePlanRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<CarePlanRow>(
    // `for update of x` locks the plan row only, not the user it joins.
    `${PLANS} where x.id = $1${options.forUpdate ? ' for update of x' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const TASKS = `
  select t.id, t.plan_id, t.description, t.due_at, t.done_at, t.done_by,
         u.name as done_by_name, t.done_note
  from care_plan_tasks t
  left join users u on u.id = t.done_by`;

export async function tasksOfPlans(
  client: pg.ClientBase,
  planIds: string[],
): Promise<CarePlanTaskRow[]> {
  if (planIds.length === 0) return [];
  const { rows } = await client.query<CarePlanTaskRow>(
    `${TASKS} where t.plan_id = any($1::uuid[]) order by t.created_at, t.id`,
    [planIds],
  );
  return rows;
}

export async function findCarePlanTask(
  client: pg.ClientBase,
  id: string,
): Promise<(CarePlanTaskRow & { admission_id: string }) | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<CarePlanTaskRow & { admission_id: string }>(
    `select t.id, t.plan_id, t.admission_id, t.description, t.due_at, t.done_at, t.done_by,
            u.name as done_by_name, t.done_note
     from care_plan_tasks t left join users u on u.id = t.done_by where t.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

interface StayIds {
  admissionId: string;
  encounterId: string;
  patientId: string;
}

export async function insertCarePlan(
  client: pg.ClientBase,
  plan: StayIds & { problem: string; goal?: string | undefined },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into care_plans (tenant_id, admission_id, encounter_id, patient_id, problem, goal,
                             created_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [plan.admissionId, plan.encounterId, plan.patientId, plan.problem, plan.goal ?? null, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('care plan was not recorded');
  return id;
}

export async function insertCarePlanTask(
  client: pg.ClientBase,
  task: StayIds & { planId: string; description: string; dueAt?: Date | undefined },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into care_plan_tasks (tenant_id, plan_id, admission_id, encounter_id, patient_id,
                                  description, due_at, created_by, created_at)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, clock_timestamp())
     returning id`,
    [
      task.planId,
      task.admissionId,
      task.encounterId,
      task.patientId,
      task.description,
      task.dueAt ?? null,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('task was not recorded');
  return id;
}

export async function closeCarePlan(
  client: pg.ClientBase,
  id: string,
  status: 'completed' | 'cancelled',
  userId: string,
): Promise<void> {
  await client.query(
    `update care_plans set status = $2, closed_at = now(), closed_by = $3 where id = $1`,
    [id, status, userId],
  );
}

export async function completeCarePlanTask(
  client: pg.ClientBase,
  id: string,
  note: string | undefined,
  userId: string,
): Promise<void> {
  await client.query(
    `update care_plan_tasks set done_at = now(), done_by = $2, done_note = $3 where id = $1`,
    [id, userId, note ?? null],
  );
}
