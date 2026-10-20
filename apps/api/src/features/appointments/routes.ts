import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { bookAppointment, bookingRefusal } from './booking.js';
import {
  findAppointment,
  hasPassed,
  listAppointments,
  moveAppointment,
  practisingDoctor,
  setStatus,
  slotAt,
  slotsOn,
  type AppointmentRow,
  type Visibility,
} from './repository.js';
import {
  APPOINTMENT_SCHEMAS,
  Appointment,
  AppointmentCancel,
  AppointmentCreate,
  AppointmentListQuery,
  AppointmentPage,
  AppointmentParams,
  AppointmentReschedule,
  AppointmentStatusChange,
  FreeSlots,
  FreeSlotsQuery,
  type AppointmentStatusValue,
} from './schemas.js';

const FEATURE = 'appointments';
const READ = 'appointment:read';
const CREATE = 'appointment:create';
const UPDATE = 'appointment:update';

/** The most days one list may cover, `from` and `to` included. */
const MAX_RANGE_DAYS = 31;
const DAY_MS = 86_400_000;

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const notFound = () => new HttpError(404, 'appointment_not_found', 'No such appointment');

/** A real calendar date as YYYY-MM-DD, as a number of days, or null. */
function dayNumber(day: string): number | null {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) return null;
  return parsed / DAY_MS;
}

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const visibilityFor = (request: FastifyRequest, permission: Permission): Visibility => ({
  scope: request.access.scope(permission),
  userId: userIdOf(request),
});

const summary = (row: AppointmentRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  doctorId: row.doctor_id,
  doctorName: row.doctor_name,
  ...(row.department_name === null ? {} : { departmentName: row.department_name }),
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  version: row.version,
});

const record = (row: AppointmentRow) => ({
  ...summary(row),
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.cancel_reason === null
    ? {}
    : {
        cancellation: {
          reason: row.cancel_reason as AppointmentCancel['reason'],
          ...(row.cancel_note === null ? {} : { note: row.cancel_note }),
        },
      }),
});

/** A note of plain text, of a few lines, required for the reason `other`. */
function noteFor(reason: string, note: string | undefined): string | null {
  const tidied = tidyLinesOptional(note, 500);
  if (reason === 'other' && tidied === null) throw invalid('A note is required for "other"');
  return tidied;
}

const SCHEDULED_ONLY =
  ' Only a scheduled appointment changes: completed, cancelled and no-show are final, and a change of one gives 409 `invalid_transition`. The `version` must be the current one, or 409 `conflict`. The rules are enforced in the same transaction as the change, on the locked row. An appointment of another hospital, or outside the scope the caller holds `appointment:update` with, answers 404 `appointment_not_found`, the same as one that does not exist. The same `idempotency-key` changes nothing again and answers with the appointment as it is now. Audited.';

const SAME_ANSWER = ' An appointment of another hospital answers 404 `appointment_not_found`.';

export const appointmentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of APPOINTMENT_SCHEMAS) app.addSchema(schema);

  app.get(
    '/appointments',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listAppointments',
        tags: ['appointments'],
        description:
          'The appointments of the active hospital that start on the days from `from` to `to` (calendar days at the hospital, both included, at most 31 days), by start time then id. Filtered by doctor and by status. A list, not a search: nothing in its address is typed about a patient, so it is a GET. Each row names its patient (name and MRN) for anyone who may read appointments. The scope of the caller’s `appointment:read` is applied on the server, whatever the filters say: with scope `own`, only the appointments of the caller’s own doctor profile are returned, a `doctorId` of another doctor gives an empty page, and `total` counts only what the caller may see; with `department`, those of the departments of the caller’s profile. Every page read is audited, with the ids of the appointments returned. `total` comes with the first page only.',
        querystring: AppointmentListQuery,
        response: { 200: ref(AppointmentPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { from, to, doctorId, status, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const first = dayNumber(from);
      const last = dayNumber(to);
      if (first === null || last === null) throw invalid('from and to must be calendar dates');
      if (last < first || last - first >= MAX_RANGE_DAYS) {
        throw invalid('The days are not a range the list allows');
      }
      const page = await listAppointments(
        request.txClient,
        {
          from,
          to,
          ...(doctorId === undefined ? {} : { doctorId }),
          ...(status === undefined ? {} : { status: status as AppointmentStatusValue }),
          ...(cursor === undefined ? {} : { cursor }),
          limit,
        },
        visibilityFor(request, READ),
      );
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      // Each row names a patient: every one shown is a record read.
      for (const row of page.rows) request.audit('read', 'appointment', row.id);
      return {
        items: page.rows.map(summary),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.get(
    '/appointments/free-slots',
    {
      // Either of two permissions, which the guard cannot say: checked below.
      config: { permissions: [], feature: FEATURE },
      schema: {
        operationId: 'listFreeSlots',
        tags: ['appointments'],
        description:
          'A doctor’s free slots on one calendar day at the hospital, in order: the slots of the doctor’s weekly working hours (cut into the doctor’s consultation length, `consultationMinutes` of the profile) that overlap no scheduled appointment of the doctor and have not started yet. Cancelled and no-show appointments free their slot. Needs `appointment:create` or `appointment:update` (to book, or to move a booking). A list of times for a doctor and a day: nothing in its address is about a patient, so it is a GET. A day more than 90 days ahead, or before today, gives an empty list. An unknown or inactive doctor gives 404 `not_found`.',
        querystring: FreeSlotsQuery,
        response: { 200: ref(FreeSlots), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const policy = await request.access.policy();
      const held = new Set(policy?.permissions.map((grant) => grant.permission));
      if (!held.has(CREATE) && !held.has(UPDATE)) {
        throw new HttpError(403, 'permission_denied', `Needs ${CREATE} or ${UPDATE}`);
      }
      const { doctorId, day } = request.query;
      if (dayNumber(day) === null) throw invalid('day must be a calendar date');
      const doctor = await practisingDoctor(request.txClient, doctorId);
      if (!doctor) throw new HttpError(404, 'not_found', 'No such doctor');
      const slots = await slotsOn(request.txClient, doctor, day, { free: true });
      return {
        doctorId: doctor.id,
        day,
        slotMinutes: doctor.consultation_minutes,
        slots: slots.map((slot) => ({
          startsAt: slot.starts_at.toISOString(),
          endsAt: slot.ends_at.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/appointments',
    {
      // The answer names the patient: only the new id is kept for a repeat, which is answered
      // from the appointment as it is then.
      config: {
        permissions: [CREATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createAppointment',
        tags: ['appointments'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Books an appointment for a patient with a doctor, starting at one of the doctor’s free slots (see `/appointments/free-slots`); the server sets its end from the slot length. Needs `appointment:create`. The Idempotency-Key header is required: a repeat with the same key books nothing and answers with the appointment as it is now. Two bookings can never hold the same doctor at the same time: a database exclusion constraint on the doctor’s scheduled appointments decides between simultaneous requests, and the loser is refused with 409 `slot_taken`. A patient cannot be booked at a time that overlaps one of their own scheduled appointments, with any doctor: 409 `patient_overlap`. A start that is not a slot of the doctor’s working hours, is already past or is more than 90 days ahead is refused with 422 `outside_hours`. An unknown patient or an unknown or inactive doctor gives 422 `unknown_patient` or `unknown_doctor`, the same whether the id belongs to another hospital or to none. `extensions` holds the values of the fields other features add to the booking form (the `appointment.form.fields` slot), keyed by feature id; a part for a feature that registered no schema is refused (422 `unknown_extension`), and no feature registers one yet. The reason is stored as plain text. The answer names the patient (name and MRN) to anyone who may book. Writes `appointment.created` to the outbox and the audit log in the same transaction.',
        body: ref(AppointmentCreate),
        response: { 201: ref(Appointment), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      // Booked only with a doctor the caller's scope of `appointment:create` reaches.
      const visibility = visibilityFor(request, CREATE);
      if (request.replayOf !== null) {
        const booked = request.idempotentId
          ? await findAppointment(request.txClient, request.idempotentId, visibility)
          : null;
        if (!booked) throw notFound();
        // The answer is the record as it is now: a read, though nothing is booked again.
        request.audit('read', 'appointment', booked.id);
        return reply.status(201).send(record(booked));
      }
      const body = request.body as AppointmentCreate;
      const extensions = Object.entries(body.extensions ?? {});
      if (extensions.some(([, part]) => typeof part !== 'object' || part === null)) {
        throw invalid('Each part of extensions is an object');
      }
      // No feature registers fields for the booking form yet, so any part is one nobody knows.
      if (extensions.length > 0) {
        throw new HttpError(422, 'unknown_extension', 'A part of extensions belongs to no feature');
      }
      const id = await bookAppointment(
        request,
        {
          patientId: body.patientId,
          doctorId: body.doctorId,
          startsAt: body.startsAt,
          reason: tidyLinesOptional(body.reason, 500),
        },
        visibility,
      );
      request.idempotentId = id;
      const booked = await findAppointment(request.txClient, id, visibility);
      if (!booked) throw notFound();
      return reply.status(201).send(record(booked));
    },
  );

  app.get(
    '/appointments/:appointmentId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getAppointment',
        tags: ['appointments'],
        description:
          'One appointment: the list fields, the reason for the visit and, when cancelled, why. Needs `appointment:read`, under the same rule as the list for naming the patient and for scope. Every read is audited.' +
          SAME_ANSWER,
        params: AppointmentParams,
        response: { 200: ref(Appointment), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findAppointment(
        request.txClient,
        request.params.appointmentId,
        visibilityFor(request, READ),
      );
      if (!row) throw notFound();
      request.audit('read', 'appointment', row.id);
      return record(row);
    },
  );

  /**
   * The shape every change shares: a repeat answers with the appointment as it is now; otherwise
   * the row is locked, found within the caller's scope, must be scheduled and at the version the
   * change was made from, and `change` does the rest.
   */
  async function changeAppointment(
    request: FastifyRequest<{ Params: { appointmentId: string } }>,
    reply: FastifyReply,
    version: number,
    change: (row: AppointmentRow, visibility: Visibility) => Promise<void>,
  ) {
    const visibility = visibilityFor(request, UPDATE);
    const id = request.params.appointmentId;
    if (request.replayOf === null) {
      const row = await findAppointment(request.txClient, id, visibility, { forUpdate: true });
      if (!row) throw notFound();
      if (row.status !== 'scheduled') {
        throw new HttpError(
          409,
          'invalid_transition',
          `A ${row.status} appointment does not change`,
        );
      }
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The appointment has changed since it was read');
      }
      await change(row, visibility);
      request.audit('update', 'appointment', row.id);
    }
    const now = await findAppointment(request.txClient, id, visibility);
    if (!now) throw notFound();
    // A repeat changes nothing and answers with the record as it is now: a read.
    if (request.replayOf !== null) request.audit('read', 'appointment', now.id);
    return reply.status(200).send(record(now));
  }

  const changeSchema = (
    operationId: string,
    description: string,
    body: typeof AppointmentReschedule | typeof AppointmentCancel | typeof AppointmentStatusChange,
  ) => ({
    operationId,
    tags: ['appointments'],
    description: description + SCHEDULED_ONLY,
    headers: RequiredIdempotencyHeaders,
    params: AppointmentParams,
    body: ref(body),
    response: { 200: ref(Appointment), ...errors(400, 401, 403, 404, 409, 422, 429) },
  });

  const changeConfig = {
    permissions: [UPDATE],
    feature: FEATURE,
    idempotent: { body: 'none', required: true },
  } as const;

  app.post(
    '/appointments/:appointmentId/reschedule',
    {
      config: changeConfig,
      schema: changeSchema(
        'rescheduleAppointment',
        'Moves a scheduled appointment to one of a doctor’s free slots, with the same doctor or another, and a reason. Its id stays. The free times and refusals are those of booking: 409 `slot_taken` when another appointment holds the doctor (the exclusion constraint decides), 409 `patient_overlap` when the patient has another appointment then, 422 `outside_hours` for a time that is not a slot or has started, and 422 `unknown_doctor`. The appointment’s own old time never counts against it. Writes `appointment.rescheduled` to the outbox with the old and the new start and the reason; the note is not kept. Needs `appointment:update`.',
        AppointmentReschedule,
      ),
    },
    async (request, reply) => {
      const body = request.body as AppointmentReschedule;
      noteFor(body.reason, body.note);
      // Moved only to a doctor the caller's scope of `appointment:update` reaches.
      return changeAppointment(request, reply, body.version, async (row, visibility) => {
        const doctor = await practisingDoctor(request.txClient, body.doctorId, visibility);
        if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
        const slot = await slotAt(request.txClient, doctor, body.startsAt);
        if (!slot) throw new HttpError(422, 'outside_hours', 'Not a slot of the working hours');
        try {
          await moveAppointment(request.txClient, row.id, doctor.id, slot);
        } catch (error) {
          throw bookingRefusal(error);
        }
        await request.emit('appointment.rescheduled', row.id, {
          appointmentId: row.id,
          patientId: row.patient_id,
          fromDoctorId: row.doctor_id,
          doctorId: doctor.id,
          fromStartsAt: row.starts_at.toISOString(),
          startsAt: slot.starts_at.toISOString(),
          reason: body.reason,
        });
      });
    },
  );

  app.post(
    '/appointments/:appointmentId/cancel',
    {
      config: changeConfig,
      schema: changeSchema(
        'cancelAppointment',
        'Cancels a scheduled appointment that has not ended, with a reason from the list and a note (required for `other`). Its time is freed at once. One that has ended is refused with 422 `too_late`: it is completed or a no-show. Writes `appointment.cancelled` to the outbox with the reason. Needs `appointment:update`.',
        AppointmentCancel,
      ),
    },
    async (request, reply) => {
      const body = request.body as AppointmentCancel;
      const note = noteFor(body.reason, body.note);
      return changeAppointment(request, reply, body.version, async (row) => {
        if (await hasPassed(request.txClient, row.ends_at)) {
          throw new HttpError(422, 'too_late', 'The appointment has ended');
        }
        await setStatus(request.txClient, row.id, 'cancelled', { reason: body.reason, note });
        await request.emit('appointment.cancelled', row.id, {
          appointmentId: row.id,
          patientId: row.patient_id,
          doctorId: row.doctor_id,
          reason: body.reason,
        });
      });
    },
  );

  for (const [path, operationId, status, event, description] of [
    [
      'complete',
      'completeAppointment',
      'completed',
      'appointment.completed',
      'Marks a scheduled appointment as completed: the patient was seen. Not before it starts (422 `too_early`). Writes `appointment.completed` to the outbox. Closing an OPD encounter will complete its appointment the same way (M7). Needs `appointment:update`.',
    ],
    [
      'no-show',
      'markAppointmentNoShow',
      'no_show',
      'appointment.no_show',
      'Marks a scheduled appointment as a no-show: the patient did not come. Not before it starts (422 `too_early`). Its time is freed. Writes `appointment.no_show` to the outbox. Needs `appointment:update`.',
    ],
  ] as const) {
    app.post(
      `/appointments/:appointmentId/${path}`,
      {
        config: changeConfig,
        schema: changeSchema(operationId, description, AppointmentStatusChange),
      },
      async (request, reply) => {
        const body = request.body as AppointmentStatusChange;
        return changeAppointment(request, reply, body.version, async (row) => {
          if (!(await hasPassed(request.txClient, row.starts_at))) {
            throw new HttpError(422, 'too_early', 'The appointment has not started');
          }
          await setStatus(request.txClient, row.id, status);
          await request.emit(event, row.id, {
            appointmentId: row.id,
            patientId: row.patient_id,
            doctorId: row.doctor_id,
          });
        });
      },
    );
  }
};
