import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyLines } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { RecoveryNoteInput, RecoveryRecord } from './recovery-schemas.js';
import { SurgeryParams } from './schemas.js';
import { isUuid, userIdOf } from './util.js';

const FEATURE = 'theatre';

interface Booking {
  id: string;
  patient_id: string;
  status: string;
  encounter_id: string | null;
}

async function findBooking(client: pg.ClientBase, id: string, lock = false): Promise<Booking> {
  const { rows } = isUuid(id)
    ? await client.query<Booking>(
        `select id, patient_id, status, encounter_id from ot_bookings where id = $1 ${lock ? 'for update' : ''}`,
        [id],
      )
    : { rows: [] as Booking[] };
  const row = rows[0];
  if (!row) throw new HttpError(404, 'surgery_not_found', 'No such surgery');
  return row;
}

async function record(client: pg.ClientBase, booking: Booking): Promise<RecoveryRecord> {
  const { rows } = await client.query<{
    id: string;
    text: string;
    pain_score: number | null;
    readiness: 'in_recovery' | 'ready_for_ward';
    added_by: string;
    added_at: Date;
    name: string | null;
  }>(
    `select r.id, r.text, r.pain_score, r.readiness, r.added_by, r.added_at, u.name
       from ot_recovery_notes r left join users u on u.id = r.added_by
      where r.booking_id = $1 order by r.added_at, r.id`,
    [booking.id],
  );
  return {
    surgeryId: booking.id,
    encounterId: booking.encounter_id,
    notes: rows.map((r) => ({
      id: r.id,
      text: r.text,
      painScore: r.pain_score,
      readiness: r.readiness,
      addedBy: r.added_by,
      addedByName: r.name ?? '',
      addedAt: r.added_at.toISOString(),
    })),
  };
}

/**
 * Recovery-room notes of a surgery (#917, OT-04 #179). Insert-only: a correction is a new
 * note. Reads need `theatre:read` and are audited; adding needs `surgery:perform` once the
 * surgery has started. The text of a note never leaves in an event or an audit entry.
 */
export const recoveryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/theatre/surgeries/:surgeryId/recovery',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'getRecovery',
        tags: ['theatre'],
        description:
          'Recovery-room notes of one surgery, oldest first, with the visit it is charged to (OT-04, #179). Audited as a read of the surgery. Requires theatre:read.',
        params: SurgeryParams,
        response: { 200: ref(RecoveryRecord), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const booking = await findBooking(request.txClient, request.params.surgeryId);
      request.audit('read', 'surgery', booking.id);
      return record(request.txClient, booking);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/recovery',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'addRecoveryNote',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds a recovery note once the surgery has started (409 `invalid_state` before, or after it was cancelled). Notes are append-only: a correction is a new note. The server takes the author and time. The Idempotency-Key header is required; a repeat adds nothing. Answers the whole record. Audited. Requires surgery:perform.',
        params: SurgeryParams,
        body: RecoveryNoteInput,
        response: { 201: ref(RecoveryRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      void reply.code(201);
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking);
      }
      if (booking.status !== 'in_progress' && booking.status !== 'completed') {
        throw new HttpError(
          409,
          'invalid_state',
          `A recovery note is added once the surgery has started; this one is ${booking.status}`,
        );
      }
      const b = request.body;
      const { rows } = await client.query<{ id: string }>(
        `insert into ot_recovery_notes (booking_id, text, pain_score, readiness, added_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [booking.id, tidyLines(b.text), b.painScore ?? null, b.readiness, userIdOf(request)],
      );
      request.audit('update', 'surgery', booking.id);
      await request.emit('surgery.recovery_note_added', booking.id, {
        patientId: booking.patient_id,
        noteId: rows[0]?.id,
        encounterId: booking.encounter_id,
      });
      return record(client, booking);
    },
  );
};
