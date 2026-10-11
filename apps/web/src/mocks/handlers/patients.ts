import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
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
onMockReset(() => {
  patients = seed();
  registrations = new Map();
  counters = new Map();
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
    return HttpResponse.json({ items });
  }),

  http.post('*/api/patients', async ({ request }) => {
    const access = authorize(request, { permission: 'patient:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const replay = registrations.get(`${access.tenantId}:${key}`);
    if (replay) return HttpResponse.json<PatientRecord>(replay, { status: 201 });

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
        recordedBy: 'user_mock',
      },
    };
    // The list holds summaries only: no email, address or consent.
    const { email: _email, address: _address, contactConsent: _consent, ...summary } = record;
    patients.push(summary);
    registrations.set(`${access.tenantId}:${key}`, record);
    return HttpResponse.json<PatientRecord>(record, { status: 201 });
  }),
];
