import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyLines } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  AddendumInput,
  OperationNoteInput,
  OperationRecord,
  SurgeryEncounterInput,
} from './operation-schemas.js';
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

/** The note is written once the surgery has started, and not for one that was cancelled. */
function requireStarted(booking: Booking): void {
  if (booking.status !== 'in_progress' && booking.status !== 'completed') {
    throw new HttpError(
      409,
      'invalid_state',
      `An operation note is written once the surgery has started; this one is ${booking.status}`,
    );
  }
}

const iso = (value: Date) => value.toISOString();
const opt = <K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> =>
  value === null ? {} : ({ [key]: value } as Record<K, V>);

async function record(client: pg.ClientBase, booking: Booking): Promise<OperationRecord> {
  const { rows } = await client.query<{
    procedure_done: string;
    findings: string | null;
    technique: string | null;
    complications: string | null;
    blood_loss_ml: number | null;
    specimens: string | null;
    post_op_plan: string | null;
    saved_by: string;
    saved_at: Date;
    signed_at: Date | null;
    signed_by: string | null;
    name: string | null;
  }>(
    `select n.procedure_done, n.findings, n.technique, n.complications, n.blood_loss_ml,
            n.specimens, n.post_op_plan, n.saved_by, n.saved_at, n.signed_at, n.signed_by, u.name
       from ot_notes n left join users u on u.id = n.signed_by where n.booking_id = $1`,
    [booking.id],
  );
  const n = rows[0];
  const addenda = await client.query<{
    id: string;
    text: string;
    added_by: string;
    added_at: Date;
    name: string | null;
  }>(
    `select a.id, a.text, a.added_by, a.added_at, u.name
       from ot_note_addenda a left join users u on u.id = a.added_by
      where a.booking_id = $1 order by a.added_at, a.id`,
    [booking.id],
  );
  return {
    surgeryId: booking.id,
    encounterId: booking.encounter_id,
    note: n
      ? {
          procedureDone: n.procedure_done,
          ...opt('findings', n.findings),
          ...opt('technique', n.technique),
          ...opt('complications', n.complications),
          ...opt('bloodLossMl', n.blood_loss_ml),
          ...opt('specimens', n.specimens),
          ...opt('postOpPlan', n.post_op_plan),
          savedAt: iso(n.saved_at),
          savedBy: n.saved_by,
          ...(n.signed_at === null || n.signed_by === null
            ? {}
            : { signedAt: iso(n.signed_at), signedBy: n.signed_by, signedByName: n.name ?? '' }),
        }
      : null,
    addenda: addenda.rows.map((a) => ({
      id: a.id,
      text: a.text,
      addedBy: a.added_by,
      addedByName: a.name ?? '',
      addedAt: iso(a.added_at),
    })),
  };
}

const tidy = (value: string | undefined): string | null =>
  value === undefined ? null : tidyLines(value) || null;

/**
 * The operation note of a surgery and the visit it is charged to (#178). The note is a draft
 * until signed, then never changed; a correction is a signed addendum. Reads need `theatre:read`,
 * writes `surgery:perform`. Every read and write is audited against the surgery. The text of a
 * note never leaves in an event.
 */
export const operationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/theatre/surgeries/:surgeryId/operation-note',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'getOperationNote',
        tags: ['theatre'],
        description:
          'The operation note of one surgery with its addenda, and the visit the surgery is charged to (OT-03, #178). `note` is null before one is saved. Audited as a read of the surgery. Requires theatre:read.',
        params: SurgeryParams,
        response: { 200: ref(OperationRecord), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const booking = await findBooking(request.txClient, request.params.surgeryId);
      request.audit('read', 'surgery', booking.id);
      return record(request.txClient, booking);
    },
  );

  app.put(
    '/theatre/surgeries/:surgeryId/operation-note',
    {
      config: { permissions: ['surgery:perform'], feature: FEATURE },
      schema: {
        operationId: 'saveOperationNote',
        tags: ['theatre'],
        description:
          'Saves the operation note as a draft, replacing the draft before it. 409 `already_signed` once signed; 409 `invalid_state` before the surgery has started or after it was cancelled. Requires surgery:perform.',
        params: SurgeryParams,
        body: OperationNoteInput,
        response: { 200: ref(OperationRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      requireStarted(booking);
      const { rows } = await client.query<{ signed_at: Date | null }>(
        'select signed_at from ot_notes where booking_id = $1 for update',
        [booking.id],
      );
      if (rows[0]?.signed_at) {
        throw new HttpError(409, 'already_signed', 'A signed operation note is not changed');
      }
      const b = request.body;
      await client.query(
        `insert into ot_notes (booking_id, procedure_done, findings, technique, complications,
                               blood_loss_ml, specimens, post_op_plan, saved_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (tenant_id, booking_id) do update
           set procedure_done = excluded.procedure_done, findings = excluded.findings,
               technique = excluded.technique, complications = excluded.complications,
               blood_loss_ml = excluded.blood_loss_ml, specimens = excluded.specimens,
               post_op_plan = excluded.post_op_plan, saved_by = excluded.saved_by,
               saved_at = now()`,
        [
          booking.id,
          tidyLines(b.procedureDone),
          tidy(b.findings),
          tidy(b.technique),
          tidy(b.complications),
          b.bloodLossMl ?? null,
          tidy(b.specimens),
          tidy(b.postOpPlan),
          userIdOf(request),
        ],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/operation-note/sign',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'signOperationNote',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Signs the operation note: the server takes the time and the signed-in user. A signed note is never changed (409 `already_signed`); 404 `note_not_found` without a draft; 409 `invalid_state` for a cancelled or unstarted surgery. The Idempotency-Key header is required. Audited. Requires surgery:perform.',
        params: SurgeryParams,
        response: { 200: ref(OperationRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking);
      }
      requireStarted(booking);
      const { rows } = await client.query<{ signed_at: Date | null }>(
        'select signed_at from ot_notes where booking_id = $1 for update',
        [booking.id],
      );
      if (!rows[0]) throw new HttpError(404, 'note_not_found', 'There is no note to sign');
      if (rows[0].signed_at) {
        throw new HttpError(409, 'already_signed', 'The operation note is already signed');
      }
      await client.query(
        'update ot_notes set signed_at = now(), signed_by = $2 where booking_id = $1',
        [booking.id, userIdOf(request)],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/operation-note/addenda',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'addOperationNoteAddendum',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an addendum to a signed operation note: the correction of a signed note, with the signer and time taken by the server. 409 `not_signed` while the note is a draft or missing. The Idempotency-Key header is required; a repeat adds nothing. Audited. Requires surgery:perform.',
        params: SurgeryParams,
        body: AddendumInput,
        response: { 200: ref(OperationRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', booking.id);
        return record(client, booking);
      }
      const { rows } = await client.query<{ signed_at: Date | null }>(
        'select signed_at from ot_notes where booking_id = $1',
        [booking.id],
      );
      if (!rows[0]?.signed_at) {
        throw new HttpError(409, 'not_signed', 'An addendum goes to a signed note');
      }
      await client.query(
        'insert into ot_note_addenda (booking_id, text, added_by) values ($1, $2, $3)',
        [booking.id, tidyLines(request.body.text), userIdOf(request)],
      );
      request.audit('update', 'surgery', booking.id);
      return record(client, booking);
    },
  );

  app.put(
    '/theatre/surgeries/:surgeryId/encounter',
    {
      config: { permissions: ['surgery:schedule'], feature: FEATURE },
      schema: {
        operationId: 'linkSurgeryEncounter',
        tags: ['theatre'],
        description:
          'Names the visit (encounter) the surgery and its consumables are charged to. The visit must be an open one of the same patient (422 `unknown_encounter`); only a scheduled or in-progress surgery is linked (409 `invalid_state`). Charges follow the link: nothing is charged for a surgery with none. Audited. Requires surgery:schedule.',
        params: SurgeryParams,
        body: SurgeryEncounterInput,
        response: { 200: ref(OperationRecord), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const booking = await findBooking(client, request.params.surgeryId, true);
      if (booking.status !== 'scheduled' && booking.status !== 'in_progress') {
        throw new HttpError(
          409,
          'invalid_state',
          `The visit of a ${booking.status} surgery is not changed`,
        );
      }
      const encounterId = request.body.encounterId.toLowerCase();
      const { rows } = isUuid(encounterId)
        ? await client.query(
            `select 1 from encounters where id = $1 and patient_id = $2 and status = 'open'`,
            [encounterId, booking.patient_id],
          )
        : { rows: [] };
      if (rows.length === 0) {
        throw new HttpError(422, 'unknown_encounter', 'No such open visit of this patient');
      }
      await client.query('update ot_bookings set encounter_id = $2 where id = $1', [
        booking.id,
        encounterId,
      ]);
      request.audit('update', 'surgery', booking.id);
      return record(client, { ...booking, encounter_id: encounterId });
    },
  );
};
