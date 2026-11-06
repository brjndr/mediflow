import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset } from '../db';
import { error, unauthenticated } from '../respond';

type Hospital = components['schemas']['PlatformHospital'];
type HospitalPage = components['schemas']['PlatformHospitalPage'];
type Invite = components['schemas']['PlatformInvite'];
type InvitePage = components['schemas']['PlatformInvitePage'];

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
/** Open invites by hospital id. */
let invites = new Map<string, Invite[]>();
let invited = 0;
onMockReset(() => {
  hospitals = seed();
  created = 0;
  invites = new Map();
  invited = 0;
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

  http.get('*/api/platform/hospitals/:id', ({ params }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const hospital = hospitals.find((h) => h.id === params.id);
    if (!hospital) return error(404, 'not_found', 'No such hospital');
    return HttpResponse.json<Hospital>(hospital);
  }),

  http.patch('*/api/platform/hospitals/:id', async ({ params, request }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const hospital = hospitals.find((h) => h.id === params.id);
    if (!hospital) return error(404, 'not_found', 'No such hospital');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (body.version !== hospital.version) {
      return error(409, 'version_conflict', 'The hospital was changed by someone else');
    }
    const limit = (value: unknown, max: number) =>
      value === null ||
      (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max);
    if (
      ('maxUsers' in body && !limit(body.maxUsers, 1_000_000)) ||
      ('storageMb' in body && !limit(body.storageMb, 100_000_000))
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if ('maxUsers' in body) hospital.maxUsers = body.maxUsers as number | null;
    if ('storageMb' in body) hospital.storageMb = body.storageMb as number | null;
    hospital.version += 1;
    return HttpResponse.json<Hospital>(hospital);
  }),

  http.put('*/api/platform/hospitals/:id/features', async ({ params, request }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const hospital = hospitals.find((h) => h.id === params.id);
    if (!hospital) return error(404, 'not_found', 'No such hospital');
    const body = (await request.json().catch(() => null)) as {
      features?: { feature?: unknown; enabled?: unknown }[];
    } | null;
    const entries = body?.features;
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.some(
        (e) =>
          typeof e.feature !== 'string' ||
          !/^[a-z][a-z0-9_]*$/.test(e.feature) ||
          typeof e.enabled !== 'boolean',
      )
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    for (const { feature, enabled } of entries as { feature: string; enabled: boolean }[]) {
      const known = hospital.features.find((f) => f.feature === feature);
      if (known) known.enabled = enabled;
      else hospital.features.push({ feature, enabled });
    }
    return HttpResponse.json<Hospital>(hospital);
  }),

  http.get('*/api/platform/hospitals/:id/admin-invites', ({ params }) => {
    const denied = platformOnly();
    if (denied) return denied;
    if (!hospitals.some((h) => h.id === params.id))
      return error(404, 'not_found', 'No such hospital');
    return HttpResponse.json<InvitePage>({
      items: [...(invites.get(String(params.id)) ?? [])].reverse(),
      nextCursor: null,
    });
  }),

  http.post('*/api/platform/hospitals/:id/admin-invite', async ({ params, request }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const hospital = hospitals.find((h) => h.id === params.id);
    if (!hospital) return error(404, 'not_found', 'No such hospital');
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      email?: unknown;
    } | null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (
      typeof body?.name !== 'string' ||
      body.name.trim() === '' ||
      !/^[^\s@]+@[^\s@]+$/.test(email)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (hospital.status !== 'active') {
      return error(409, 'hospital_not_active', 'The hospital is not active');
    }
    // The mock's hospitals with staff already have an admin.
    if (hospital.memberCount > 0) {
      return error(409, 'hospital_has_admin', 'The hospital already has an admin');
    }
    if (email.startsWith('platform.')) {
      return error(400, 'validation_failed', 'That address belongs to a platform admin');
    }
    const open = (invites.get(hospital.id) ?? []).filter((i) => i.email !== email);
    const invite: Invite = {
      id: `invite_${++invited}`,
      email,
      name: body.name.trim(),
      expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    };
    invites.set(hospital.id, [...open, invite]);
    return HttpResponse.json<Invite>(invite, { status: 201 });
  }),

  http.post('*/api/platform/hospitals/:id/admin-invites/:inviteId/revoke', ({ params }) => {
    const denied = platformOnly();
    if (denied) return denied;
    const id = String(params.id);
    const open = invites.get(id) ?? [];
    if (!open.some((i) => i.id === params.inviteId)) {
      return error(404, 'not_found', 'No such open invite');
    }
    invites.set(
      id,
      open.filter((i) => i.id !== params.inviteId),
    );
    return new HttpResponse(null, { status: 204 });
  }),
];
