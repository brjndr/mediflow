import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  departmentState,
  findDoctor,
  hoursOf,
  insertDoctor,
  isActiveMember,
  listCandidates,
  listDoctors,
  lockDoctor,
  replaceHours,
  updateDoctor,
  UUID,
  violation,
  type DoctorRow,
  type HoursRow,
} from './repository.js';
import {
  CandidateListQuery,
  Doctor,
  DOCTOR_SCHEMAS,
  DoctorAvailability,
  DoctorAvailabilityUpdate,
  DoctorCandidatePage,
  DoctorCreate,
  DoctorListQuery,
  DoctorPage,
  DoctorUpdate,
  REGISTRATION_MAX,
  SPECIALIZATION_MAX,
  WEEKDAYS,
  type DoctorSession,
} from './schemas.js';

const FEATURE = 'doctors';
const READ = 'doctor:read';
const MANAGE = 'doctor:manage';

const view = (row: DoctorRow): Doctor => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  name: row.name,
  departmentId: row.department_id,
  departmentName: row.department_name,
  specialization: row.specialization,
  ...(row.registration_number === null ? {} : { registrationNumber: row.registration_number }),
  consultationMinutes: row.consultation_minutes,
  active: row.active,
  version: row.version,
});

// One answer for a doctor that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'doctor_not_found', 'No such doctor');
const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const conflict = () => new HttpError(409, 'conflict', 'It has changed');

const OTHER_HOSPITAL =
  ' A doctor of another hospital answers 404 doctor_not_found, the same as one that does not exist.';

/** A specialization as it is stored, and not empty once it is tidied. */
function cleanSpecialization(text: string): string {
  const tidied = tidyWithin(text, SPECIALIZATION_MAX);
  if (tidied === '') throw invalid('A specialization is required');
  return tidied;
}

/** An empty registration number is none. */
const cleanRegistration = (text: string | undefined): string | null =>
  tidyOptional(text, REGISTRATION_MAX);

/**
 * A department a doctor may be put in: one of this hospital, and not archived. Row-level
 * security is what makes another hospital's department "not found" here.
 */
async function usableDepartment(client: pg.ClientBase, id: string): Promise<void> {
  const state = await departmentState(client, id);
  if (!state || state.archived) throw invalid('Not an active department of this hospital');
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The sessions as rows, in order, once each ends after it starts and none of a day overlap. */
function toHours(sessions: DoctorSession[]): HoursRow[] {
  const rows = sessions
    .map((session) => ({
      day: WEEKDAYS.indexOf(session.day) + 1,
      start_minute: minutes(session.start),
      end_minute: minutes(session.end),
    }))
    .sort((a, b) => a.day - b.day || a.start_minute - b.start_minute);
  rows.forEach((row, index) => {
    if (row.end_minute <= row.start_minute) throw invalid('A session must end after it starts');
    const before = rows[index - 1];
    if (before && before.day === row.day && row.start_minute < before.end_minute) {
      throw invalid('Two sessions of a day overlap');
    }
  });
  return rows;
}

const availability = (doctor: DoctorRow, hours: HoursRow[]) => ({
  doctorId: doctor.id,
  sessions: hours.map((row) => ({
    day: WEEKDAYS[row.day - 1] ?? 'mon',
    start: clock(row.start_minute),
    end: clock(row.end_minute),
  })),
  version: doctor.hours_version,
});

const sameHours = (a: HoursRow[], b: HoursRow[]) =>
  a.length === b.length &&
  a.every(
    (row, index) =>
      row.day === b[index]?.day &&
      row.start_minute === b[index]?.start_minute &&
      row.end_minute === b[index]?.end_minute,
  );

export const doctorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DOCTOR_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ doctorId: Type.String({ maxLength: 64 }) });

  // Before `/doctors/:doctorId`, which would otherwise take "candidates" for an id.
  app.get(
    '/doctors/candidates',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'listDoctorCandidates',
        tags: ['doctors'],
        description:
          'Active staff members of the active tenant who have no doctor profile yet, by name: who a profile can be created for. `q` matches the name or the email address. Staff are users, not patients.',
        querystring: CandidateListQuery,
        response: { 200: ref(DoctorCandidatePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, q = '' } = request.query;
      const list = await listCandidates(request.txClient, q.trim(), { cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map((row) => ({ userId: row.id, name: row.name, email: row.email })),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.get(
    '/doctors',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listDoctors',
        tags: ['doctors'],
        description:
          'Doctors of the active tenant, by name. `q` matches the name or the specialization. `total` comes with the first page.',
        querystring: DoctorListQuery,
        response: { 200: ref(DoctorPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const {
        cursor,
        limit = DEFAULT_PAGE_SIZE,
        q = '',
        departmentId,
        active = true,
      } = request.query;
      // Not an id of anything: no doctor is in such a department.
      if (departmentId !== undefined && !UUID.test(departmentId)) {
        return { items: [], nextCursor: null, total: 0 };
      }
      const list = await listDoctors(
        request.txClient,
        { q: q.trim(), departmentId: departmentId ?? null, active },
        { cursor, limit },
      );
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(view),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/doctors',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createDoctor',
        tags: ['doctors'],
        headers: IdempotencyHeaders,
        description:
          "Gives a staff member of the hospital a doctor profile. The hospital is the session's: the body carries no tenant. 409 doctor_exists when that person already has one, 400 when the user is not an active member or the department is not an active department of the hospital.",
        body: ref(DoctorCreate),
        response: { 201: ref(Doctor), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as DoctorCreate;
      const specialization = cleanSpecialization(body.specialization);
      // Each is judged at this hospital: row-level security shows no one and nothing of another.
      if (!(await isActiveMember(request.txClient, body.userId))) {
        throw invalid('Not an active member of this hospital');
      }
      await usableDepartment(request.txClient, body.departmentId);
      let id: string;
      try {
        id = await insertDoctor(request.txClient, body.userId, {
          departmentId: body.departmentId,
          specialization,
          registrationNumber: cleanRegistration(body.registrationNumber),
          consultationMinutes: body.consultationMinutes,
        });
      } catch (error) {
        const refused = violation(error);
        if (refused?.constraint === 'doctors_one_profile') {
          throw new HttpError(409, 'doctor_exists', 'That staff member already has a profile');
        }
        // The member or the department went away between the check and the insert.
        if (refused?.code === '23503') throw invalid('The member or the department is gone');
        throw error;
      }
      const row = await findDoctor(request.txClient, id);
      if (!row) throw new Error('doctor was not created');
      request.audit('create', 'doctor', row.id);
      return reply.status(201).send(view(row));
    },
  );

  app.get(
    '/doctors/:doctorId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getDoctor',
        tags: ['doctors'],
        description: 'One doctor.' + OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(Doctor), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findDoctor(request.txClient, request.params.doctorId);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.patch(
    '/doctors/:doctorId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'updateDoctor',
        tags: ['doctors'],
        description:
          'Changes a doctor profile, or makes it inactive or active again (active again only for someone who is still an active member, 400 otherwise). A new department must be an active department of the same hospital (400 otherwise). Send the version the change was made from: 409 conflict when the profile has changed since. Sending what the profile already has changes nothing.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(DoctorUpdate),
        response: { 200: ref(Doctor), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DoctorUpdate;
      // Locked while the versions are compared, so of two changes made from the same version
      // exactly one goes through.
      const current = await lockDoctor(request.txClient, request.params.doctorId);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) throw conflict();
      const next = {
        departmentId: body.departmentId?.toLowerCase() ?? current.department_id,
        specialization:
          body.specialization === undefined
            ? current.specialization
            : cleanSpecialization(body.specialization),
        registrationNumber:
          body.registrationNumber === undefined
            ? current.registration_number
            : cleanRegistration(body.registrationNumber),
        consultationMinutes: body.consultationMinutes ?? current.consultation_minutes,
        active: body.active ?? current.profile_active,
      };
      if (
        next.departmentId === current.department_id &&
        next.specialization === current.specialization &&
        next.registrationNumber === current.registration_number &&
        next.consultationMinutes === current.consultation_minutes &&
        next.active === current.profile_active
      ) {
        return view(current);
      }
      // Making a profile active is for someone who works here: reactivate the member first.
      if (next.active && !current.profile_active) {
        if (!(await isActiveMember(request.txClient, current.user_id))) {
          throw invalid('Not an active member of this hospital');
        }
      }
      // A doctor may stay in a department that was archived, but is not moved into one.
      if (next.departmentId !== current.department_id) {
        await usableDepartment(request.txClient, next.departmentId);
      }
      await updateDoctor(request.txClient, current.id, next);
      const row = await findDoctor(request.txClient, current.id);
      if (!row) throw new Error('doctor was not updated');
      request.audit('update', 'doctor', row.id);
      return view(row);
    },
  );

  app.get(
    '/doctors/:doctorId/availability',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getDoctorAvailability',
        tags: ['doctors'],
        description:
          "A doctor's regular weekly working hours, in the hospital's timezone. Scheduling reads this." +
          OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(DoctorAvailability), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const doctor = await findDoctor(request.txClient, request.params.doctorId);
      if (!doctor) throw notFound();
      return availability(doctor, await hoursOf(request.txClient, doctor.id));
    },
  );

  app.put(
    '/doctors/:doctorId/availability',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'setDoctorAvailability',
        tags: ['doctors'],
        description:
          'Replaces the weekly working hours. Sessions of one day must not overlap and each must end after it starts (400 otherwise); a session ends by 23:59 of its own day, so one cannot run past midnight. 409 conflict when the hours have changed since the version sent. Sending the hours the doctor already has changes nothing.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(DoctorAvailabilityUpdate),
        response: { 200: ref(DoctorAvailability), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DoctorAvailabilityUpdate;
      const hours = toHours(body.sessions);
      const doctor = await lockDoctor(request.txClient, request.params.doctorId);
      if (!doctor) throw notFound();
      if (doctor.hours_version !== body.expectedVersion) throw conflict();
      if (sameHours(hours, await hoursOf(request.txClient, doctor.id))) {
        return availability(doctor, hours);
      }
      try {
        await replaceHours(request.txClient, doctor.id, hours);
      } catch (error) {
        // The database's own rule against overlapping sessions, should the check above miss one.
        if (violation(error)?.constraint === 'doctor_hours_no_overlap') {
          throw invalid('Two sessions of a day overlap');
        }
        throw error;
      }
      request.audit('update_hours', 'doctor', doctor.id);
      return availability({ ...doctor, hours_version: doctor.hours_version + 1 }, hours);
    },
  );
};
