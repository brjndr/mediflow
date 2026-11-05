import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset } from '../db';
import { error, unauthenticated } from '../respond';

type Hospital = components['schemas']['PlatformHospital'];
type HospitalPage = components['schemas']['PlatformHospitalPage'];

function seed(): Hospital[] {
  const base = {
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    themePrimary: '#0f766e',
    themeLogoUrl: null,
    address: null,
    phone: null,
    registrationNumber: null,
    authMode: 'password',
    region: 'in',
    status: 'active',
    maxUsers: null,
    storageMb: null,
    version: 1,
    suspendedAt: null,
    offboardingRequestedAt: null,
    deleteAfter: null,
  } as const;
  return [
    {
      ...base,
      id: 'hosp_city',
      slug: 'city-general',
      name: 'City General Hospital',
      memberCount: 42,
      features: [{ feature: 'patients', enabled: true }],
      createdAt: '2026-01-10T08:00:00Z',
    },
    {
      ...base,
      id: 'hosp_clinic',
      slug: 'riverside-clinic',
      name: 'Riverside Clinic',
      memberCount: 6,
      features: [{ feature: 'patients', enabled: true }],
      createdAt: '2026-03-02T08:00:00Z',
    },
  ];
}

let hospitals = seed();
let created = 0;
onMockReset(() => {
  hospitals = seed();
  created = 0;
});

/** The mock's version of the `platform` access level: a signed-in platform admin only. */
function platformOnly(): Response | null {
  const session = currentSession();
  if (!session) return unauthenticated();
  if (!session.user.isPlatformAdmin) return error(403, 'forbidden', 'Platform administrators only');
  return null;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const platformHandlers = [
  http.get('*/api/platform/hospitals', ({ request }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const cursor = url.searchParams.get('cursor');
    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q')?.toLowerCase();
    // Newest first, as the API lists them.
    const visible = hospitals
      .filter((h) => !status || h.status === status)
      .filter((h) => !q || h.name.toLowerCase().includes(q) || h.slug.includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const start = cursor ? visible.findIndex((h) => h.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<HospitalPage>({
      items: visible.slice(start, start + limit),
      nextCursor: visible[start + limit]?.id ?? null,
      total: visible.length,
    });
  }),

  http.post('*/api/platform/hospitals', async ({ request }) => {
    const denied = platformOnly();
    if (denied) return denied;
    if (!request.headers.get('idempotency-key')) {
      return error(400, 'validation_failed', 'An Idempotency-Key is required');
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.name !== 'string' ||
      body.name.trim() === '' ||
      typeof body.slug !== 'string' ||
      !SLUG.test(body.slug) ||
      typeof body.locale !== 'string' ||
      typeof body.timezone !== 'string' ||
      typeof body.currency !== 'string' ||
      typeof body.themePrimary !== 'string'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (hospitals.some((h) => h.slug === body.slug)) {
      return error(409, 'slug_taken', 'A hospital with this slug exists');
    }
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
    const whole = (value: unknown) => (typeof value === 'number' ? value : null);
    const features = Array.isArray(body.features) ? (body.features as string[]) : [];
    const hospital: Hospital = {
      id: `hosp_new_${++created}`,
      slug: body.slug,
      name: body.name.trim(),
      locale: body.locale,
      timezone: body.timezone,
      currency: body.currency,
      themePrimary: body.themePrimary,
      themeLogoUrl: text(body.themeLogoUrl),
      address: text(body.address),
      phone: text(body.phone),
      registrationNumber: text(body.registrationNumber),
      authMode: 'password',
      region: text(body.region),
      status: 'active',
      maxUsers: whole(body.maxUsers),
      storageMb: whole(body.storageMb),
      version: 1,
      memberCount: 0,
      features: features.map((feature) => ({ feature, enabled: true })),
      createdAt: new Date().toISOString(),
      suspendedAt: null,
      offboardingRequestedAt: null,
      deleteAfter: null,
    };
    hospitals.push(hospital);
    return HttpResponse.json<Hospital>(hospital, { status: 201 });
  }),
];
