import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyLines, tidyOptional } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  AnaesthesiaInput,
  CHECKLIST_PHASES,
  ChecklistParams,
  ChecklistStepInput,
  FitnessInput,
  PeriopRecord,
} from './periop-schemas.js';
import { SurgeryParams } from './schemas.js';
import { isUuid, userIdOf } from './util.js';

const FEATURE = 'theatre';

interface Booking {
  id: string;
  patient_id: string;
  status: string;
}

async function findBooking(client: pg.ClientBase, id: string, lock = false): Promise<Booking> {
  const { rows } = isUuid(id)
    ? await client.query<Booking>(
        `select id, patient_id, status from ot_bookings where id = $1 ${lock ? 'for update' : ''}`,
        [id],
      )
    : { rows: [] as Booking[] };
  const row = rows[0];
  if (!row) throw new HttpError(404, 'surgery_not_found', 'No such surgery');
  return row;
}

/** Writes wait for a surgery that is still to be done or under way. */
function requireOpen(booking: Booking): void {
  if (booking.status !== 'scheduled' && booking.status !== 'in_progress') {
    throw new HttpError(
      409,
      'invalid_state',
      `The record of a ${booking.status} surgery is not changed`,
    );
  }
}

const iso = (value: Date) => value.toISOString();

/** The whole record, as every read and write answers. */
async function record(client: pg.ClientBase, surgeryId: string): Promise<PeriopRecord> {
  const steps = await client.query<{
    step: PeriopRecord['checklist'][number]['step'];
    note: string | null;
    completed_by: string;
    completed_at: Date;
    name: string | null;
  }>(
    `select s.step, s.note, s.completed_by, s.completed_at, u.name
       from ot_checklist_steps s left join users u on u.id = s.completed_by
      where s.booking_id = $1 order by s.completed_at, s.step`,
    [surgeryId],
  );
  const fitness = await client.query<{
    status: 'fit' | 'conditional' | 'unfit';
    notes: string | null;
    assessed_by: string;
    assessed_at: Date;
    name: string | null;
  }>(
    `select f.status, f.notes, f.assessed_by, f.assessed_at, u.name
       from ot_fitness f left join users u on u.id = f.assessed_by where f.booking_id = $1`,
    [surgeryId],
  );
  const anaesthesia = await client.query<{
    technique: 'general' | 'spinal' | 'epidural' | 'regional' | 'local' | 'sedation';
    asa_class: number;
    drugs: string | null;
    notes: string | null;
    saved_at: Date;
    signed_at: Date | null;
    signed_by: string | null;
    name: string | null;
  }>(
    `select a.technique, a.asa_class, a.drugs, a.notes, a.saved_at, a.signed_at, a.signed_by, u.name
       from ot_anaesthesia a left join users u on u.id = a.signed_by where a.booking_id = $1`,
    [surgeryId],
  );
  const f = fitness.rows[0];
  const a = anaesthesia.rows[0];
  return {
    surgeryId,
    checklist: steps.rows.map((row) => ({
      step: row.step,
      completedAt: iso(row.completed_at),
      completedBy: row.completed_by,
      completedByName: row.name ?? '',
      ...(row.note === null ? {} : { note: row.note }),
    })),
    fitness: f
      ? {
          status: f.status,
          ...(f.notes === null ? {} : { notes: f.notes }),
          assessedAt: iso(f.assessed_at),
          assessedBy: f.assessed_by,
          assessedByName: f.name ?? '',
        }
      : null,
    anaesthesia: a
      ? {
          technique: a.technique,
          asaClass: a.asa_class,
          ...(a.drugs === null ? {} : { drugs: a.drugs }),
          ...(a.notes === null ? {} : { notes: a.notes }),
          savedAt: iso(a.saved_at),
          ...(a.signed_at === null || a.signed_by === null
            ? {}
            : {
                signedAt: iso(a.signed_at),
                signedBy: a.signed_by,
                signedByName: a.name ?? '',
              }),
        }
      : null,
  };
}

/**
 * The peri-operative record of a surgery (#872): fitness for surgery, the checklist steps and the
 * anaesthesia record. Reads need `theatre:read`, writes `surgery:perform` on a scheduled or
 * in-progress surgery. Every read and write is audited against the surgery.
 */
export const periopRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/theatre/surgeries/:surgeryId/periop',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'getPeriop',
        tags: ['theatre'],
        description:
          'The pre-operative and peri-operative record of one surgery (OT-02, #177): fitness for surgery, the checklist steps done so far and the anaesthesia record. Audited as a read of the patient record. Requires theatre:read.',
        params: SurgeryParams,
        response: { 200: ref(PeriopRecord), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const booking = await findBooking(request.txClient, request.params.surgeryId);
      request.audit('read', 'surgery', booking.id);
      return record(request.txClient, booking.id);
    },
  );

  app.put(
    '/theatre/surgeries/:surgeryId/fitness',
    {
      config: { permissions: ['surgery:perform'], feature: FEATURE },
      schema: {
        operationId: 'recordFitness',
        tags: ['theatre'],
        description:
          'Records the assessment of fitness for surgery, replacing the one before it (each is audited). Refused with 409 `invalid_state` once the surgery is completed or cancelled. Requires surgery:perform.',
        params: SurgeryParams,
        body: FitnessInput,
        response: { 200: ref(PeriopRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      requireOpen(booking);
      await client.query(
        `insert into ot_fitness (booking_id, status, notes, assessed_by)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, booking_id) do update
           set status = excluded.status, notes = excluded.notes,
               assessed_by = excluded.assessed_by, assessed_at = now()`,
        [
          booking.id,
          request.body.status,
          request.body.notes === undefined ? null : tidyLines(request.body.notes) || null,
          userIdOf(request),
        ],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking.id);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/checklist/:step',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'completeChecklistStep',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Completes one step of the pre-operative or WHO surgical safety checklist. The server takes the time and the signed-in user as the signer; a step is never undone or redone (a repeat answers with the first entry). Steps of a phase need every step of the phases before it (409 `phase_incomplete`). 409 `invalid_state` once the surgery is completed or cancelled. The Idempotency-Key header is required. Audited; emits `surgery.checklist_step_completed` (ids and the step, never the note). Requires surgery:perform.',
        params: ChecklistParams,
        body: ChecklistStepInput,
        response: { 200: ref(PeriopRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking.id);
      }
      requireOpen(booking);
      const step = request.params.step as string;
      const phase = CHECKLIST_PHASES.findIndex((steps) =>
        (steps as readonly string[]).includes(step),
      );
      const needed = CHECKLIST_PHASES.slice(0, phase).flat();
      const { rows: done } = await client.query<{ step: string }>(
        'select step from ot_checklist_steps where booking_id = $1',
        [booking.id],
      );
      const have = new Set(done.map((row) => row.step));
      if (have.has(step)) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking.id);
      }
      if (needed.some((earlier) => !have.has(earlier))) {
        throw new HttpError(
          409,
          'phase_incomplete',
          'Every step of the phases before this one comes first',
        );
      }
      await client.query(
        'insert into ot_checklist_steps (booking_id, step, note, completed_by) values ($1, $2, $3, $4)',
        [booking.id, step, tidyOptional(request.body?.note, 300), userIdOf(request)],
      );
      request.audit('update', 'surgery', booking.id);
      await request.emit('surgery.checklist_step_completed', booking.id, {
        patientId: booking.patient_id,
        step,
      });
      return record(client, booking.id);
    },
  );

  app.put(
    '/theatre/surgeries/:surgeryId/anaesthesia',
    {
      config: { permissions: ['surgery:perform'], feature: FEATURE },
      schema: {
        operationId: 'saveAnaesthesia',
        tags: ['theatre'],
        description:
          'Saves the anaesthesia record as a draft, replacing the draft before it. 409 `already_signed` once signed; 409 `invalid_state` once the surgery is completed or cancelled. Requires surgery:perform.',
        params: SurgeryParams,
        body: AnaesthesiaInput,
        response: { 200: ref(PeriopRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      requireOpen(booking);
      const body = request.body;
      const { rows } = await client.query<{ signed_at: Date | null }>(
        'select signed_at from ot_anaesthesia where booking_id = $1 for update',
        [booking.id],
      );
      if (rows[0]?.signed_at) {
        throw new HttpError(409, 'already_signed', 'A signed anaesthesia record is not changed');
      }
      await client.query(
        `insert into ot_anaesthesia (booking_id, technique, asa_class, drugs, notes)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, booking_id) do update
           set technique = excluded.technique, asa_class = excluded.asa_class,
               drugs = excluded.drugs, notes = excluded.notes, saved_at = now()`,
        [
          booking.id,
          body.technique,
          body.asaClass,
          body.drugs === undefined ? null : tidyLines(body.drugs) || null,
          body.notes === undefined ? null : tidyLines(body.notes) || null,
        ],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking.id);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/anaesthesia/sign',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'signAnaesthesia',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Signs the anaesthesia record: the server takes the time and the signed-in user. A signed record is never changed and is signed once (409 `already_signed`). 404 `anaesthesia_not_found` without a draft; 409 `invalid_state` once the surgery is completed or cancelled. The Idempotency-Key header is required. Audited. Requires surgery:perform.',
        params: SurgeryParams,
        response: { 200: ref(PeriopRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking.id);
      }
      requireOpen(booking);
      const { rows } = await client.query<{ signed_at: Date | null }>(
        'select signed_at from ot_anaesthesia where booking_id = $1 for update',
        [booking.id],
      );
      if (!rows[0]) {
        throw new HttpError(404, 'anaesthesia_not_found', 'There is no anaesthesia record to sign');
      }
      if (rows[0].signed_at) {
        throw new HttpError(409, 'already_signed', 'The anaesthesia record is already signed');
      }
      await client.query(
        'update ot_anaesthesia set signed_at = now(), signed_by = $2 where booking_id = $1',
        [booking.id, userIdOf(request)],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking.id);
    },
  );
};
