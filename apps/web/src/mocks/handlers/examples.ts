import { http, HttpResponse } from 'msw';
import { activeTenantId, currentSession, TENANT_IDS } from '../db';
import { error, tenantMismatch, unauthenticated } from '../respond';

/**
 * Data for the UI example pages. Mock only: there is no such endpoint in the API contract.
 * Synthetic people, enough of them to exercise server-side sorting, paging and virtualisation.
 */
const DEPARTMENTS = ['cardiology', 'neurology', 'orthopaedics', 'paediatrics'] as const;
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

interface Person {
  id: string;
  tenantId: string;
  name: string;
  department: (typeof DEPARTMENTS)[number];
  phone: string;
  mrn: string;
  balanceMinor: number;
}

function build(tenantId: string, prefix: string, count: number): Person[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${String(index + 1).padStart(4, '0')}`,
    tenantId,
    // Deterministic, so tests and screenshots are stable.
    name: `${GIVEN[index % GIVEN.length]} ${FAMILY[(index * 7) % FAMILY.length]} ${index + 1}`,
    department: DEPARTMENTS[index % DEPARTMENTS.length] ?? 'cardiology',
    phone: `+91 90000 ${String(10_000 + index).slice(-5)}`,
    mrn: `MRN-EX-${String(count - index).padStart(5, '0')}`,
    balanceMinor: index % 5 === 0 ? 0 : (index + 1) * 12_345,
  }));
}

const people = [...build(TENANT_IDS.hospital, 'exh', 520), ...build(TENANT_IDS.clinic, 'exc', 12)];

const SORTABLE = new Set(['name', 'mrn']);

export const examplesHandlers = [
  http.get('*/api/examples/people', ({ request }) => {
    if (!currentSession()) return unauthenticated();
    const mismatch = tenantMismatch(request);
    if (mismatch) return mismatch;

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const sort = url.searchParams.get('sort');
    const key = sort?.replace(/^-/, '');
    if (sort && (!key || !SORTABLE.has(key))) {
      return error(400, 'validation_failed', 'Cannot sort by that field');
    }

    // Only the session hospital's rows, sorted on the server.
    const rows = people.filter((person) => person.tenantId === activeTenantId());
    if (key === 'name' || key === 'mrn') {
      const direction = sort?.startsWith('-') ? -1 : 1;
      rows.sort((a, b) => a[key].localeCompare(b[key], 'en', { numeric: true }) * direction);
    }

    const cursor = url.searchParams.get('cursor');
    const start = cursor ? rows.findIndex((person) => person.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      items: rows.slice(start, start + limit),
      nextCursor: rows[start + limit]?.id ?? null,
      total: rows.length,
    });
  }),
];
