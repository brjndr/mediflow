import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type PatientSummary = components['schemas']['PatientSummary'];
type PatientPage = components['schemas']['PatientPage'];

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
onMockReset(() => {
  patients = seed();
});

const fullName = (patient: PatientSummary) => `${patient.firstName} ${patient.lastName}`;
const digits = (text: string) => text.replace(/\D/g, '');
const SORT_KEYS = new Set(['name', 'mrn']);

export const patientsHandlers = [
  http.get('*/api/patients', ({ request }) => {
    const access = authorize(request, { permission: 'patient:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const sort = url.searchParams.get('sort');
    const key = sort?.replace(/^-/, '');
    if (sort && (!key || !SORT_KEYS.has(key))) {
      return error(400, 'validation_failed', 'Cannot sort by that field');
    }

    // Tenant isolation: only rows of the session's tenant are ever considered.
    let rows = patients.filter((patient) => patient.tenantId === access.tenantId);

    // Search happens here, on the "server": name, phone or MRN.
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
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

    const cursor = url.searchParams.get('cursor');
    const start = cursor ? rows.findIndex((patient) => patient.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<PatientPage>({
      items: rows.slice(start, start + limit),
      nextCursor: rows[start + limit]?.id ?? null,
      total: rows.length,
    });
  }),
];
