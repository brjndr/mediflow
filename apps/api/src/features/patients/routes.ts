import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  findDuplicates,
  findPatient,
  insertPatient,
  searchPatients,
  todayAtHospital,
  updatePatient,
  type PatientRow,
  type Visibility,
} from './repository.js';
import {
  PATIENT_SCHEMAS,
  PatientCreate,
  PatientDuplicateMatches,
  PatientDuplicateQuery,
  PatientPage,
  PatientRecord,
  PatientSearch,
  PatientUpdate,
  type PatientSort,
} from './schemas.js';

const FEATURE = 'patients';
const CONTACT = 'patient.contact:read';

const DOT = '•';
/** Keeps the last `visible` characters readable, as the web app's own masks do. */
function maskEnd(value: string, visible: number): string {
  const text = value.trim();
  if (text.length <= visible) return DOT.repeat(text.length);
  return DOT.repeat(text.length - visible) + text.slice(-visible);
}
const maskPhone = (phone: string) => maskEnd(phone.replace(/[^\d+]/g, ''), 4);
const maskMrn = (mrn: string) => maskEnd(mrn, 3);

const summary = (row: PatientRow, contact: boolean) => ({
  id: row.id,
  tenantId: row.tenant_id,
  mrn: row.mrn,
  firstName: row.first_name,
  lastName: row.last_name,
  dob: row.dob,
  gender: row.gender,
  phone: contact ? row.phone : maskPhone(row.phone),
});

const record = (row: PatientRow, contact: boolean) => ({
  ...summary(row, contact),
  ...(contact && row.email !== null ? { email: row.email } : {}),
  ...(contact && row.address !== null ? { address: row.address } : {}),
  ...(row.contact_consent_given !== null &&
  row.contact_consent_at &&
  row.contact_consent_recorded_by
    ? {
        contactConsent: {
          given: row.contact_consent_given,
          at: row.contact_consent_at.toISOString(),
          recordedBy: row.contact_consent_recorded_by,
        },
      }
    : {}),
});

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/** Whether the caller's role may see contact details in full. A field-level permission. */
async function seesContact(request: FastifyRequest): Promise<boolean> {
  const policy = await request.access.policy();
  return policy?.permissions.some((grant) => grant.permission === CONTACT) ?? false;
}

const NARROWEST = ['department', 'own', 'all'] as const;

/** What the caller may see or change: the narrowest scope among the permissions the route needs. */
const visibilityFor = (
  request: FastifyRequest,
  ...permissions: ('patient:read' | 'patient:update')[]
): Visibility => {
  const scopes = permissions.map((permission) => request.access.scope(permission));
  return {
    scope: NARROWEST.find((scope) => scopes.includes(scope)) ?? 'all',
    userId: userIdOf(request),
  };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A real calendar date, not before 1900 and not after today where the hospital is. */
function checkDob(dob: string, today: string): void {
  const parsed = new Date(`${dob}T00:00:00Z`);
  if (
    !ISO_DATE.test(dob) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== dob
  ) {
    throw invalid('dob must be a calendar date (YYYY-MM-DD)');
  }
  if (dob > today || dob < '1900-01-01') throw invalid('dob is out of range');
}

interface Demographics {
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  email?: string | null;
  address?: string | null;
}

/**
 * Trims what was typed and checks what the schema cannot. Returns the cleaned values. An email
 * or address of only spaces is left out, the same as not sending one.
 */
function clean<T extends Demographics>(input: T, today: string): T {
  const out = { ...input };
  for (const field of ['firstName', 'lastName'] as const) {
    if (out[field] === undefined) continue;
    out[field] = out[field].trim();
    if (out[field] === '') throw invalid(`${field} is required`);
  }
  if (out.dob !== undefined) checkDob(out.dob, today);
  if (out.phone !== undefined) {
    out.phone = out.phone.trim();
    if (out.phone.replace(/\D/g, '').length < 5) throw invalid('phone needs at least 5 digits');
  }
  if (typeof out.email === 'string') {
    out.email = out.email.trim();
    if (out.email === '') out.email = null;
    else if (!EMAIL.test(out.email)) throw invalid('email is not a valid address');
  }
  if (typeof out.address === 'string') {
    out.address = out.address.trim();
    if (out.address === '') out.address = null;
  }
  return out;
}

const notFound = () => new HttpError(404, 'not_found', 'No such patient');

export const patientRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of PATIENT_SCHEMAS) app.addSchema(schema);

  app.post(
    '/patients/search',
    {
      config: { permissions: ['patient:read'], feature: FEATURE },
      schema: {
        operationId: 'searchPatients',
        tags: ['patients'],
        description:
          'Patients of the active hospital, one cursor page at a time. The search term travels in the body, never in a query string, because it can be a name, a phone number or an MRN. Every word of the term must appear in the name or MRN, in any order; a term that looks like a phone number is also matched against phone numbers for a caller who holds patient.contact:read. It reads data only. `total` is given on the first page.',
        body: PatientSearch,
        response: { 200: ref(PatientPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { q, cursor, limit = DEFAULT_PAGE_SIZE } = request.body;
      const sort = (request.body.sort ?? 'name') as PatientSort;
      const contact = await seesContact(request);
      const result = await searchPatients(
        request.txClient,
        { q, cursor, limit, sort, byPhone: contact },
        visibilityFor(request, 'patient:read'),
      );
      // One entry for the search, not one per row: the rows shown are identified by the record
      // reads that follow.
      request.audit('search', 'patient');
      return {
        items: result.rows.map((row) => summary(row, contact)),
        nextCursor: result.nextCursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      };
    },
  );

  app.post(
    '/patients/duplicate-check',
    {
      config: { permissions: ['patient:create'], feature: FEATURE },
      schema: {
        operationId: 'checkPatientDuplicates',
        tags: ['patients'],
        description:
          'Finds existing patients who may be the same person as one about to be registered, across the whole hospital. The identifying details travel in the body, never in a query string. Matches are masked and carry no id. It reads data only.',
        body: ref(PatientDuplicateQuery),
        response: { 200: ref(PatientDuplicateMatches), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = clean(
        request.body as Static<typeof PatientDuplicateQuery>,
        await todayAtHospital(request.txClient),
      );
      const rows = await findDuplicates(request.txClient, query);
      request.audit('duplicate_check', 'patient');
      return {
        items: rows.map((row) => ({
          firstName: row.first_name,
          lastName: row.last_name,
          dob: row.dob,
          maskedMrn: maskMrn(row.mrn),
          maskedPhone: maskPhone(row.phone),
        })),
      };
    },
  );

  app.post(
    '/patients',
    {
      // Only the status and the new id are kept for a replay: the response is patient data.
      config: {
        permissions: ['patient:create'],
        feature: FEATURE,
        idempotent: { required: true },
      },
      schema: {
        operationId: 'createPatient',
        tags: ['patients'],
        headers: IdempotencyHeaders,
        description:
          'Registers a patient in the active hospital and assigns the MRN. The Idempotency-Key header is required: a retried or double-submitted request returns the first result instead of a second patient. A replay answers with the id only; read the record to show it. The server records when and by whom contact consent was captured.',
        body: ref(PatientCreate),
        response: { 201: ref(PatientRecord), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = userIdOf(request);
      const input = clean(request.body as PatientCreate, await todayAtHospital(request.txClient));
      const row = await insertPatient(request.txClient, input, userId);
      request.audit('create', 'patient', row.id);
      await request.emit('patient.registered', row.id, { patientId: row.id });
      return reply.status(201).send(record(row, await seesContact(request)));
    },
  );

  const IdParams = Type.Object({ id: Type.String({ maxLength: 64 }) });

  app.get(
    '/patients/:id',
    {
      config: { permissions: ['patient:read'], feature: FEATURE, audit: { entity: 'patient' } },
      schema: {
        operationId: 'getPatient',
        tags: ['patients'],
        description:
          'One patient of the active hospital, with the details captured at registration.',
        params: IdParams,
        response: { 200: ref(PatientRecord), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findPatient(
        request.txClient,
        request.params.id,
        visibilityFor(request, 'patient:read'),
      );
      // One answer for a record that does not exist, belongs to another hospital, or is outside
      // the caller's scope.
      if (!row) throw notFound();
      return record(row, await seesContact(request));
    },
  );

  app.patch(
    '/patients/:id',
    {
      // Both: the answer is the whole record, so changing one is also reading it.
      config: {
        permissions: ['patient:read', 'patient:update'],
        feature: FEATURE,
        audit: { entity: 'patient' },
      },
      schema: {
        operationId: 'updatePatient',
        tags: ['patients'],
        description:
          'Changes registration details of a patient. Only the fields sent are changed; null clears email or address. The MRN and the hospital never change. Sending a contactConsent that differs from the one on record records the new decision with the time and the caller. Values the record already has change nothing.',
        params: IdParams,
        body: ref(PatientUpdate),
        response: { 200: ref(PatientRecord), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const userId = userIdOf(request);
      const changes = clean(request.body as PatientUpdate, await todayAtHospital(request.txClient));
      if (Object.keys(changes).length === 0) throw invalid('Nothing to change');
      const contact = await seesContact(request);
      // Someone who cannot see contact details cannot overwrite them either.
      if (!contact && ['phone', 'email', 'address'].some((field) => field in changes)) {
        throw new HttpError(403, 'permission_denied', `Changing contact details needs ${CONTACT}`);
      }
      const existing = await findPatient(
        request.txClient,
        request.params.id,
        visibilityFor(request, 'patient:read', 'patient:update'),
        { forUpdate: true },
      );
      if (!existing) throw notFound();
      const updated = await updatePatient(request.txClient, existing, changes, userId);
      // Field names only: what changed is in the record, never in the event. Nothing is
      // announced when nothing really changed.
      if (updated.fields.length > 0) {
        await request.emit('patient.updated', existing.id, {
          patientId: existing.id,
          fields: updated.fields,
        });
      }
      return record(updated.row, contact);
    },
  );
};
