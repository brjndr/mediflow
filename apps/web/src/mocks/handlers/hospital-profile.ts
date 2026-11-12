import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, setTenantLetterhead } from '../db';
import { authorize, error } from '../respond';

type HospitalProfile = components['schemas']['HospitalProfile'];

const READ = 'hospitalProfile:read';
const MANAGE = 'hospitalProfile:manage';

/** How many times each hospital's profile was changed. The version is this plus one. */
let changes = new Map<string, number>();
onMockReset(() => {
  changes = new Map();
});

type Key = 'address' | 'phone' | 'registrationNumber' | 'gstin';
const KEYS: Key[] = ['address', 'phone', 'registrationNumber', 'gstin'];

function profileOf(tenantId: string): HospitalProfile {
  const tenant = currentSession()?.activeTenant;
  const profile: HospitalProfile = { version: (changes.get(tenantId) ?? 0) + 1 };
  if (!tenant || tenant.id !== tenantId) return profile;
  for (const key of KEYS) {
    const value = tenant[key];
    if (value) profile[key] = value;
  }
  return profile;
}

/** What another admin does meanwhile: changes the details behind the open screen. */
export function editMockHospitalProfile(
  tenantId: string,
  details: Partial<Record<Key, string | undefined>>,
): void {
  setTenantLetterhead(tenantId, details);
  changes.set(tenantId, (changes.get(tenantId) ?? 0) + 1);
}

export const hospitalProfileHandlers = [
  http.get('*/api/hospital-profile', ({ request }) => {
    const access = authorize(request, { permission: READ });
    if ('denied' in access) return access.denied;
    return HttpResponse.json(profileOf(access.tenantId));
  }),

  http.patch('*/api/hospital-profile', async ({ request }) => {
    const access = authorize(request, { permission: MANAGE });
    if ('denied' in access) return access.denied;
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const record = body as Record<string, unknown>;
    if (typeof record.expectedVersion !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (record.expectedVersion !== profileOf(access.tenantId).version) {
      return error(409, 'conflict', 'The hospital profile has changed');
    }
    const details: Partial<Record<Key, string | undefined>> = {};
    for (const key of KEYS) {
      const value = record[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') return error(400, 'validation_failed', 'Not valid');
      const text = value.trim();
      if (key === 'gstin' && text !== '' && !/^[0-9]{2}[A-Za-z0-9]{13}$/.test(text)) {
        return error(400, 'validation_failed', 'Not a GSTIN');
      }
      details[key] = text === '' ? undefined : key === 'gstin' ? text.toUpperCase() : text;
    }
    const before = profileOf(access.tenantId);
    const merged: Partial<Record<Key, string | undefined>> = {};
    for (const key of KEYS) merged[key] = key in details ? details[key] : before[key];
    const changed = KEYS.some((key) => merged[key] !== before[key]);
    // The version moves only when a detail did.
    if (changed) editMockHospitalProfile(access.tenantId, details);
    return HttpResponse.json(profileOf(access.tenantId));
  }),
];
