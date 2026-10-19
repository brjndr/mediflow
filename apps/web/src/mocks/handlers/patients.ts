import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { maskMrn, maskPhone } from '@/shared/utils/mask';
import { currentPolicy, currentSession, onMockReset, registerMockLink, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type PatientSummary = components['schemas']['PatientSummary'];
type PatientPage = components['schemas']['PatientPage'];
type PatientRecord = components['schemas']['PatientRecord'];

const FEATURE_FLAG = 'patients';
const GIVEN = ['Asha', 'Bilal', 'Chen', 'Divya', 'Emeka', 'Farah', 'Gita', 'Hugo', 'Imran', 'Jaya'];
const FAMILY = [
  'Verma',
  'Khan',
  'Wei',
  'Nair',
  'Okafor',
  'Aziz',
  'Rao',
  'Silva',
  'Shaikh',
  'Menon',
];
const GENDERS = ['female', 'male', 'other'] as const;

/** Synthetic patients, deterministic. The hospital has 12,000 so paging at scale is exercised. */
function build(tenantId: string, prefix: string, count: number): PatientSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${String(index + 1).padStart(5, '0')}`,
    tenantId,
    mrn: `MRN-${prefix.toUpperCase()}-${String(index + 1).padStart(5, '0')}`,
    firstName: GIVEN[index % GIVEN.length] ?? 'Asha',
    lastName: `${FAMILY[(index * 7) % FAMILY.length] ?? 'Verma'}${index + 1}`,
    dob: new Date(Date.UTC(1950 + (index % 60), index % 12, (index % 28) + 1))
      .toISOString()
      .slice(0, 10),
    gender: GENDERS[index % GENDERS.length] ?? 'other',
    phone: `+91 98000 ${String(10_000 + (index % 90_000)).slice(-5)}`,
  }));
}

function seed(): PatientSummary[] {
  return [...build(TENANT_IDS.hospital, 'pth', 12_000), ...build(TENANT_IDS.clinic, 'ptc', 40)];
}

let patients = seed();
/** Registrations already made, by tenant and idempotency key: a retry returns the first result. */
let registrations = new Map<string, PatientRecord>();
/** The last number given out per tenant, so ids and MRNs are never reused. */
let counters = new Map<string, number>();
/** Records registered or changed here, by id. Every other patient's record is derived. */
let records = new Map<string, PatientRecord>();

/**
 * A patient of this hospital as another feature's mock names one (an appointment's patient), or
 * undefined when the hospital has none such.
 */
export function mockPatient(
  tenantId: string,
  id: string,
): { id: string; name: string; mrn: string } | undefined {
  const found = patients.find((patient) => patient.id === id && patient.tenantId === tenantId);
  return found && { id: found.id, name: `${found.firstName} ${found.lastName}`, mrn: found.mrn };
}

/**
 * The whole record of a patient. Listed patients are summaries: each is given the rest of a
 * registration, the same every time, until it is changed.
 */
function recordOf(id: string): PatientRecord | undefined {
  const kept = records.get(id);
  if (kept) return kept;
  const found = patients.find((patient) => patient.id === id);
  if (!found) return undefined;
  const number = Number(found.id.replace(/\D/g, '')) || 0;
  return {
    ...found,
    email: `patient${number}@example.test`,
    address: `${number} Sample Street`,
    contactConsent: {
      given: number % 4 !== 0,
      at: '2026-03-01T09:30:00Z',
      recordedBy: 'user_admin',
    },
    version: 1,
  };
}

type PatientChanges = Partial<
  Pick<PatientRecord, 'firstName' | 'lastName' | 'dob' | 'gender' | 'phone'>
> & { email?: string | null; address?: string | null; contactConsent?: { given: boolean } };

const CHANGEABLE = new Set([
  'firstName',
  'lastName',
  'dob',
  'gender',
  'phone',
  'email',
  'address',
  'contactConsent',
]);

/** Applies a change as the server does: the version goes up, and the list shows the new values. */
function applyChange(
  record: PatientRecord,
  changes: PatientChanges,
  userId: string,
): PatientRecord {
  const { email, address, contactConsent, ...plain } = changes;
  const next: PatientRecord = { ...record, ...plain, version: record.version + 1 };
  if (email !== undefined) {
    if (email === null) delete next.email;
    else next.email = email;
  }
  if (address !== undefined) {
    if (address === null) delete next.address;
    else next.address = address;
  }
  if (contactConsent) {
    next.contactConsent = {
      given: contactConsent.given,
      at: new Date().toISOString(),
      recordedBy: userId,
    };
  }
  records.set(next.id, next);
  const { email: _e, address: _a, contactConsent: _c, version: _v, ...summary } = next;
  patients = patients.map((patient) => (patient.id === next.id ? summary : patient));
  return next;
}

/**
 * Changes a patient as someone else would have, behind the back of whoever has the record open.
 * For tests of concurrent edits.
 */
export function editMockPatient(id: string, changes: PatientChanges): void {
  const record = recordOf(id);
  if (record) applyChange(record, changes, 'user_someone_else');
}

/** A patient's date of birth, as another feature's mock needs it (triage's ranges are by age). */
export function mockPatientDob(tenantId: string, id: string): string | undefined {
  const record = recordOf(id);
  return record?.tenantId === tenantId ? record.dob : undefined;
}

/** A record as the caller may see it: without the contact permission, masked and trimmed. */
function visible(record: PatientRecord): PatientRecord {
  const seesContact = currentPolicy()?.permissions.some(
    (grant) => grant.permission === 'patient.contact:read',
  );
  if (seesContact) return record;
  const { email: _email, address: _address, ...rest } = record;
  return { ...rest, phone: maskPhone(rest.phone) };
}
// A link to a patient (/open/patient/<id>) opens the record at the hospital that owns it.
registerMockLink(
  'patient',
  (id) => patients.find((patient) => patient.id === id)?.tenantId ?? null,
);

onMockReset(() => {
  patients = seed();
  registrations = new Map();
  counters = new Map();
  records = new Map();
});

const fullName = (patient: PatientSummary) => `${patient.firstName} ${patient.lastName}`;
const digits = (text: string) => text.replace(/\D/g, '');
const SORT_KEYS = new Set(['name', 'mrn']);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

export const patientsHandlers = [
  http.post('*/api/patients/search', async ({ request }) => {
    const access = authorize(request, { permission: 'patient:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;

    const body: unknown = await request.json().catch(() => null);
    const params =
      typeof body === 'object' && body !== null
        ? (body as { q?: unknown; cursor?: unknown; limit?: unknown; sort?: unknown })
        : {};
    const limit = Math.min(Math.max(Number(params.limit ?? 25), 1), 100);
    const sort = typeof params.sort === 'string' ? params.sort : null;
    const key = sort?.replace(/^-/, '');
    if (sort && (!key || !SORT_KEYS.has(key))) {
      return error(400, 'validation_failed', 'Cannot sort by that field');
    }

    // Tenant isolation: only rows of the session's tenant are ever considered.
    let rows = patients.filter((patient) => patient.tenantId === access.tenantId);

    // Search happens here, on the "server": name, phone or MRN.
    const q = (typeof params.q === 'string' ? params.q : '').trim().toLowerCase();
    if (q) {
      const qDigits = digits(q);
      rows = rows.filter(
        (patient) =>
          fullName(patient).toLowerCase().includes(q) ||
          patient.mrn.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && digits(patient.phone).includes(qDigits)),
      );
    }

    if (key === 'name' || key === 'mrn') {
      const direction = sort?.startsWith('-') ? -1 : 1;
      const text = (patient: PatientSummary) => (key === 'name' ? fullName(patient) : patient.mrn);
      rows = [...rows].sort(
        (a, b) => text(a).localeCompare(text(b), 'en', { numeric: true }) * direction,
      );
    }

    const cursor = typeof params.cursor === 'string' ? params.cursor : null;
    const start = cursor ? rows.findIndex((patient) => patient.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<PatientPage>({
      items: rows.slice(start, start + limit),
      nextCursor: rows[start + limit]?.id ?? null,
      total: rows.length,
    });
  }),

  http.post('*/api/patients/duplicate-check', async ({ request }) => {
    const access = authorize(request, { permission: 'patient:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readObject(request);
    if (
      !body ||
      !isText(body.firstName) ||
      !isText(body.lastName) ||
      !isText(body.dob) ||
      !isText(body.phone)
    ) {
      return error(400, 'validation_failed', 'Name, date of birth and phone are required');
    }
    const name = `${body.firstName} ${body.lastName}`.toLowerCase();
    // Same date of birth, and the same phone number or the same name.
    const items = patients
      .filter(
        (patient) =>
          patient.tenantId === access.tenantId &&
          patient.dob === body.dob &&
          (digits(patient.phone) === digits(body.phone as string) ||
            fullName(patient).toLowerCase() === name),
      )
      .slice(0, 5);
    // Masked on the server: the caller can recognise the person but cannot read the details.
    return HttpResponse.json({
      items: items.map((patient) => ({
        firstName: patient.firstName,
        lastName: patient.lastName,
        dob: patient.dob,
        maskedMrn: maskMrn(patient.mrn),
        maskedPhone: maskPhone(patient.phone),
      })),
    });
  }),

  http.post('*/api/patients', async ({ request }) => {
    const access = authorize(request, { permission: 'patient:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const replay = registrations.get(`${access.tenantId}:${key}`);
    // As the real API does: a repeat is answered with the new record's id only, and says so.
    if (replay) {
      return HttpResponse.json(
        { id: replay.id },
        { status: 201, headers: { 'Idempotent-Replayed': 'true' } },
      );
    }

    const body = await readObject(request);
    if (
      !body ||
      !isText(body.firstName) ||
      !isText(body.lastName) ||
      !isText(body.dob) ||
      !isText(body.phone) ||
      !GENDERS.some((g) => g === body.gender)
    ) {
      return error(400, 'validation_failed', 'Some details are not valid');
    }
    // The server assigns the MRN, unique per tenant, and records who gave consent and when.
    const prefix = access.tenantId === TENANT_IDS.hospital ? 'pth' : 'ptc';
    const next =
      (counters.get(access.tenantId) ??
        patients.filter((patient) => patient.tenantId === access.tenantId).length) + 1;
    counters.set(access.tenantId, next);
    const consent = body.contactConsent as { given?: unknown } | undefined;
    const record: PatientRecord = {
      id: `${prefix}_${String(next).padStart(5, '0')}`,
      tenantId: access.tenantId,
      mrn: `MRN-${prefix.toUpperCase()}-${String(next).padStart(5, '0')}`,
      firstName: body.firstName,
      lastName: body.lastName,
      dob: body.dob,
      gender: body.gender as PatientRecord['gender'],
      phone: body.phone,
      email: isText(body.email) ? body.email : undefined,
      address: isText(body.address) ? body.address : undefined,
      contactConsent: {
        given: consent?.given === true,
        at: new Date().toISOString(),
        recordedBy: currentSession()?.user.id ?? 'unknown',
      },
      version: 1,
    };
    records.set(record.id, record);
    // The list holds summaries only: no email, address or consent.
    const {
      email: _email,
      address: _address,
      contactConsent: _consent,
      version: _version,
      ...summary
    } = record;
    patients.push(summary);
    registrations.set(`${access.tenantId}:${key}`, record);
    return HttpResponse.json<PatientRecord>(record, { status: 201 });
  }),

  http.get('*/api/patients/:id', ({ request, params }) => {
    const access = authorize(request, { permission: 'patient:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const record = recordOf(String(params.id));
    // One answer for a record that does not exist and one in another hospital.
    if (!record || record.tenantId !== access.tenantId) {
      return error(404, 'not_found', 'No such patient');
    }
    return HttpResponse.json(visible(record));
  }),

  http.patch('*/api/patients/:id', async ({ request, params }) => {
    // Both permissions, as on the real API: the answer is the whole record.
    const read = authorize(request, { permission: 'patient:read', featureFlag: FEATURE_FLAG });
    if ('denied' in read) return read.denied;
    const access = authorize(request, { permission: 'patient:update', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readObject(request);
    if (!body || typeof body.expectedVersion !== 'number') {
      return error(400, 'validation_failed', 'expectedVersion is required');
    }
    const { expectedVersion } = body;
    // Only the fields that can be changed are taken: anything else in the body is dropped.
    const changes = Object.fromEntries(
      Object.entries(body).filter(([field]) => CHANGEABLE.has(field)),
    );
    if (Object.keys(changes).length === 0) {
      return error(400, 'validation_failed', 'Nothing to change');
    }
    const seesContact = currentPolicy()?.permissions.some(
      (grant) => grant.permission === 'patient.contact:read',
    );
    // Before the record is looked up, so the answer says nothing about whether it exists.
    if (!seesContact && ['phone', 'email', 'address'].some((field) => field in changes)) {
      return error(403, 'permission_denied', 'Changing contact details needs patient.contact:read');
    }
    const record = recordOf(String(params.id));
    if (!record || record.tenantId !== access.tenantId) {
      return error(404, 'not_found', 'No such patient');
    }
    // Someone else changed the record since the caller read it.
    if (record.version !== expectedVersion) {
      return error(409, 'conflict', 'The record has changed since it was read');
    }
    // As on the real API: values the record already has change nothing and count for nothing.
    const real = Object.entries(changes).some(([field, value]) =>
      field === 'contactConsent'
        ? (value as { given?: unknown }).given !== record.contactConsent?.given
        : (value ?? undefined) !== record[field as keyof PatientRecord],
    );
    if (!real) return HttpResponse.json(visible(record));
    const next = applyChange(
      record,
      changes as PatientChanges,
      currentSession()?.user.id ?? 'unknown',
    );
    return HttpResponse.json(visible(next));
  }),
];
