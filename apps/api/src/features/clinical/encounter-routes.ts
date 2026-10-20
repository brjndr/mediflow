import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission, PermissionScope } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { appointmentForCheckIn } from '../appointments/index.js';
import { patientInScope } from '../patients/index.js';
import { tokenForEncounter } from '../queue/index.js';
import {
  encounterAnswer,
  encounterNotFound,
  encounterViews,
  FEATURE,
  userIdOf,
  visibilityFor,
} from './http.js';
import {
  encounterOpenedFor,
  endEncounter,
  findEncounter,
  hasDrafts,
  hasRecords,
  insertEncounter,
  listEncounters,
  ownDoctorId,
  practisingDoctor,
  type EncounterRow,
} from './repository.js';
import {
  Encounter,
  EncounterCancel,
  EncounterClose,
  EncounterCreate,
  EncounterListQuery,
  EncounterPage,
  EncounterParams,
  REASON_MAX,
  type EncounterStatusValue,
} from './schemas.js';

const READ = 'encounter:read';
const CREATE = 'encounter:create';
const UPDATE = 'encounter:update';

/** What the caller holds a permission of another module with, read from the policy. */
async function grantOf(
  request: FastifyRequest,
  permission: string,
  feature: string,
): Promise<PermissionScope | null> {
  const policy = await request.access.policy();
  if (policy?.features[feature] !== true) return null;
  const grant = policy.permissions.find((held) => held.permission === permission);
  return grant ? (grant.scope ?? 'all') : null;
}

export const encounterRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/encounters',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listEncounters',
        tags: ['clinical'],
        description:
          'The encounters the caller may see, newest first: of one patient (the clinical timeline), of one doctor, in one status, or any of those together. Ids that are not the hospital’s match nothing. Within the scope the caller holds encounter:read with: `own`, the encounters they attend; `department`, those of their department; an encounter outside it is left out, never refused. A list nobody types patient facts into, so a GET. Requires encounter:read and the clinical feature flag. Every encounter of a page is audited. `total` comes with the first page only.',
        querystring: EncounterListQuery,
        response: { 200: ref(EncounterPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const {
        patientId,
        attendingDoctorId,
        status,
        cursor,
        limit = DEFAULT_PAGE_SIZE,
      } = request.query;
      const page = await listEncounters(
        request.txClient,
        {
          ...(patientId === undefined ? {} : { patientId }),
          ...(attendingDoctorId === undefined ? {} : { attendingDoctorId }),
          ...(status === undefined ? {} : { status: status as EncounterStatusValue }),
          ...(cursor === undefined ? {} : { cursor }),
          limit,
        },
        visibilityFor(request, READ),
      );
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'encounter', row.id);
      return {
        items: await encounterViews(request.txClient, page.rows),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/encounters',
    {
      // Nothing of an answer that names a patient is kept: only the new id, for a repeat.
      config: {
        permissions: [CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'openEncounter',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Starts an OPD encounter (the consultation) for a patient: from the patient’s queue token of today (422 `token_not_for_patient` otherwise), from the patient’s appointment (422 `unknown_appointment` for one that does not exist, is another patient’s, or is outside the caller’s scope of appointment:read or with the appointments module off; 409 `invalid_transition` for a cancelled or no-show one), or a walk-in with neither. The doctor is attendingDoctorId, else the token’s, else the appointment’s, else the caller’s own profile; one who does not practise here, or is outside the scope the caller holds encounter:create with (`own`: only themselves), is 422 `unknown_doctor`. The department is the doctor’s. A token or an appointment opens one encounter that is not cancelled: asking again answers 200 with that encounter as it is now; two at the same moment get a 201 and a 409 `already_open` (a unique index decides). Requires encounter:create and patient:read (checked in the handler, within its scope): a patient the caller may not read and one that does not exist are both 422 `unknown_patient`. The Idempotency-Key header is required: a repeat opens nothing and answers with the encounter. Audited, and emits `encounter.opened` through the outbox with the patient, the type, the doctor, the department and the queue token and appointment when there are (triage attaches the token’s readings to it).',
        body: ref(EncounterCreate),
        response: {
          200: ref(Encounter),
          201: ref(Encounter),
          ...errors(400, 401, 403, 404, 409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const visibility = visibilityFor(request, CREATE);
      const userId = userIdOf(request);
      if (request.replayOf !== null) {
        const opened = request.idempotentId
          ? await findEncounter(request.txClient, request.idempotentId, visibility)
          : null;
        if (!opened) throw encounterNotFound();
        request.audit('read', 'encounter', opened.id);
        // 200 when the first answer was the encounter already open for the token or appointment.
        return reply
          .status(request.replayOf === 200 ? 200 : 201)
          .send(await encounterAnswer(request.txClient, opened));
      }
      const body = request.body as EncounterCreate;

      const patientScope = await grantOf(request, 'patient:read', 'patients');
      if (
        patientScope === null ||
        !(await patientInScope(request.txClient, body.patientId, { scope: patientScope, userId }))
      ) {
        throw new HttpError(422, 'unknown_patient', 'No such patient');
      }

      let tokenDoctor: string | null = null;
      let tokenAppointment: string | null = null;
      if (body.queueTokenId !== undefined) {
        // The queue's tokens only while the hospital has the queue on.
        const queueOn = (await request.access.policy())?.features.queue === true;
        const token = queueOn
          ? await tokenForEncounter(request.txClient, body.queueTokenId, body.patientId)
          : null;
        if (!token) {
          throw new HttpError(422, 'token_not_for_patient', 'Not this patient’s token today');
        }
        if (
          token.appointmentId !== null &&
          body.appointmentId !== undefined &&
          body.appointmentId !== token.appointmentId
        ) {
          throw new HttpError(422, 'unknown_appointment', 'Not the appointment of the token');
        }
        tokenDoctor = token.doctorId;
        tokenAppointment = token.appointmentId;
      }

      let appointmentDoctor: string | null = null;
      if (body.appointmentId !== undefined) {
        const scope = await grantOf(request, 'appointment:read', 'appointments');
        const appointment =
          scope === null
            ? null
            : await appointmentForCheckIn(request.txClient, body.appointmentId, { scope, userId });
        if (!appointment || appointment.patientId !== body.patientId) {
          throw new HttpError(422, 'unknown_appointment', 'No such appointment');
        }
        if (appointment.status === 'cancelled' || appointment.status === 'no_show') {
          throw new HttpError(
            409,
            'invalid_transition',
            `The appointment is ${appointment.status}`,
          );
        }
        appointmentDoctor = appointment.doctorId;
      }

      // A token checked in from an appointment brings the appointment with it.
      const link = {
        queueTokenId: body.queueTokenId ?? null,
        appointmentId: body.appointmentId ?? tokenAppointment,
      };
      if (link.queueTokenId !== null || link.appointmentId !== null) {
        const existing = await encounterOpenedFor(request.txClient, link);
        const row =
          existing.length === 1 && existing[0]
            ? await findEncounter(request.txClient, existing[0], visibility)
            : null;
        // Two encounters (one per link), or one the caller does not reach: never handed out.
        if (existing.length > 0 && !row) {
          throw new HttpError(409, 'already_open', 'An encounter exists for it');
        }
        if (row) {
          request.idempotentId = row.id;
          request.audit('read', 'encounter', row.id);
          return reply.status(200).send(await encounterAnswer(request.txClient, row));
        }
      }

      const doctorId =
        body.attendingDoctorId ??
        tokenDoctor ??
        appointmentDoctor ??
        (await ownDoctorId(request.txClient, userId));
      const doctor = doctorId
        ? await practisingDoctor(request.txClient, doctorId, visibility)
        : null;
      if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');

      let id: string;
      try {
        id = await insertEncounter(
          request.txClient,
          { patientId: body.patientId, ...link, doctor },
          userId,
        );
      } catch (error) {
        const { code } = (error ?? {}) as { code?: unknown };
        if (code === '23505') {
          throw new HttpError(409, 'already_open', 'An encounter exists for it');
        }
        throw error;
      }
      request.idempotentId = id;
      request.audit('create', 'encounter', id);
      await request.emit('encounter.opened', id, {
        encounterId: id,
        patientId: body.patientId,
        type: 'opd',
        doctorId: doctor.id,
        departmentId: doctor.department_id,
        ...(link.queueTokenId === null ? {} : { queueTokenId: link.queueTokenId }),
        ...(link.appointmentId === null ? {} : { appointmentId: link.appointmentId }),
      });
      const opened = await findEncounter(request.txClient, id, { scope: 'all', userId });
      if (!opened) throw new Error('encounter was not opened');
      return reply.status(201).send(await encounterAnswer(request.txClient, opened));
    },
  );

  app.get(
    '/encounters/:encounterId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getEncounter',
        tags: ['clinical'],
        description:
          'One encounter. One of another hospital, or outside the scope the caller holds encounter:read with, is 404 `encounter_not_found`, as one that does not exist. Requires encounter:read and the clinical feature flag. Audited.',
        params: EncounterParams,
        response: { 200: ref(Encounter), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findEncounter(
        request.txClient,
        request.params.encounterId,
        visibilityFor(request, READ),
      );
      if (!row) throw encounterNotFound();
      request.audit('read', 'encounter', row.id);
      return encounterAnswer(request.txClient, row);
    },
  );

  /**
   * The shape both changes share: a repeat answers with the encounter as it is now; otherwise the
   * row is locked, found within the caller's scope, must be open and at the version the change
   * was made from, and `change` does the rest.
   */
  async function changeEncounter(
    request: FastifyRequest<{ Params: { encounterId: string } }>,
    reply: FastifyReply,
    version: number,
    change: (row: EncounterRow) => Promise<void>,
  ) {
    const visibility = visibilityFor(request, UPDATE);
    const id = request.params.encounterId;
    if (request.replayOf === null) {
      const row = await findEncounter(request.txClient, id, visibility, 'update');
      if (!row) throw encounterNotFound();
      if (row.status !== 'open') {
        throw new HttpError(409, 'invalid_transition', `A ${row.status} encounter does not change`);
      }
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The encounter has changed since it was read');
      }
      await change(row);
      request.audit('update', 'encounter', row.id);
    }
    const now = await findEncounter(request.txClient, id, visibility);
    if (!now) throw encounterNotFound();
    if (request.replayOf !== null) request.audit('read', 'encounter', now.id);
    return reply.status(200).send(await encounterAnswer(request.txClient, now));
  }

  const CHANGE =
    ' Only an open encounter changes: closed and cancelled are final (409 `invalid_transition`). The `version` must be the current one, or 409 `conflict`. One of another hospital, or outside the scope the caller holds encounter:update with, is 404 `encounter_not_found`. The Idempotency-Key header is required: a repeat changes nothing and answers with the encounter as it is now. Requires encounter:update and the clinical feature flag. Audited.';
  const changeConfig = {
    permissions: [UPDATE] as Permission[],
    feature: FEATURE,
    idempotent: { body: 'none', required: true },
  } as const;

  app.post(
    '/encounters/:encounterId/close',
    {
      config: changeConfig,
      schema: {
        operationId: 'closeEncounter',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Closes the encounter: the consultation is over. Refused while any note of it is a draft, whoever wrote it (409 `unsigned_notes`): sign or discard it first. Afterwards nothing new is added to it; notes are still amended, diagnoses retracted and orders moved on. Emits `encounter.closed` through the outbox with the patient and the appointment when there is one.' +
          CHANGE,
        params: EncounterParams,
        body: ref(EncounterClose),
        response: { 200: ref(Encounter), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as EncounterClose;
      return changeEncounter(request, reply, body.version, async (row) => {
        if (await hasDrafts(request.txClient, row.id)) {
          throw new HttpError(409, 'unsigned_notes', 'A note of the encounter is a draft');
        }
        await endEncounter(request.txClient, row.id, 'closed', userIdOf(request), null);
        await request.emit('encounter.closed', row.id, {
          encounterId: row.id,
          patientId: row.patient_id,
          ...(row.appointment_id === null ? {} : { appointmentId: row.appointment_id }),
        });
      });
    },
  );

  app.post(
    '/encounters/:encounterId/cancel',
    {
      config: changeConfig,
      schema: {
        operationId: 'cancelEncounter',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels an encounter opened by mistake, with a reason. Only while nothing of it is on the record and no note of it is a draft (409 `unsigned_notes`): a signed note, a diagnosis that stands, an order not cancelled or a prescription is 409 `has_records` (close it instead). Its token or appointment may then open another. Emits `encounter.cancelled` through the outbox.' +
          CHANGE,
        params: EncounterParams,
        body: ref(EncounterCancel),
        response: { 200: ref(Encounter), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as EncounterCancel;
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw new HttpError(400, 'validation_failed', 'A reason is needed');
      return changeEncounter(request, reply, body.version, async (row) => {
        // Drafts too: a cancelled encounter's draft could never be signed.
        if (await hasDrafts(request.txClient, row.id)) {
          throw new HttpError(409, 'unsigned_notes', 'A note of the encounter is a draft');
        }
        if (await hasRecords(request.txClient, row.id)) {
          throw new HttpError(409, 'has_records', 'The encounter has records');
        }
        await endEncounter(request.txClient, row.id, 'cancelled', userIdOf(request), reason);
        await request.emit('encounter.cancelled', row.id, {
          encounterId: row.id,
          patientId: row.patient_id,
        });
      });
    },
  );
};
