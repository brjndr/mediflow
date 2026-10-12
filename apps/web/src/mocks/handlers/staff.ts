import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import {
  currentPolicy,
  currentSession,
  mockRoleGrants,
  mockRoleHolds,
  mockRoleIds,
  onMockReset,
  TENANT_IDS,
  USER_IDS,
} from '../db';
import { authorize, error } from '../respond';

type StaffMember = components['schemas']['StaffMember'];
type StaffPage = components['schemas']['StaffPage'];
type StaffRoleList = components['schemas']['StaffRoleList'];
type Invite = components['schemas']['Invite'];

const FEATURE_FLAG = 'staff';
const READ = 'staff:read';
const INVITE = 'staff:invite';
const MANAGE = 'staff:manage';

/** Someone who works at one of the mock hospitals. */
export interface MockStaff {
  tenantId: string;
  userId: string;
  name: string;
  email: string;
  roleId: string;
  status: 'active' | 'deactivated';
}

interface MockInvite {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roleId: string;
}

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sana', 'Vikram', 'Zoya'];
const LAST = ['Sharma', 'Iyer', 'Khan', 'Nair', 'Patel', 'Reddy', 'Singh', 'Verma', 'Das'];

/** Synthetic staff: names from two short lists, so every one is distinct and none is real. */
function generate(tenantId: string, prefix: string, domain: string, count: number): MockStaff[] {
  return Array.from({ length: count }, (_, index) => {
    const first = FIRST[index % FIRST.length] ?? 'Staff';
    const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Member';
    return {
      tenantId,
      userId: `${prefix}_${String(index + 1).padStart(2, '0')}`,
      name: `${first} ${last}`,
      email: `${first}.${last}@${domain}`.toLowerCase(),
      roleId: 'doctor',
      status: 'active',
    };
  });
}

/**
 * The people of the two mock hospitals as they start out: generated staff, then the people who
 * can sign in to the mock, at the hospitals they belong to. Other mocks (doctors) build on it.
 */
export function seedStaffDirectory() {
  const hospital = generate(TENANT_IDS.hospital, 'stf_h', 'sample-hospital.test', 36);
  const clinic = generate(TENANT_IDS.clinic, 'stf_c', 'riverside-clinic.test', 3);
  const signIn = (
    tenantId: string,
    userId: string,
    name: string,
    email: string,
    roleId: string,
  ): MockStaff => ({ tenantId, userId, name, email, roleId, status: 'active' });
  const all: MockStaff[] = [
    ...hospital,
    ...clinic,
    signIn(
      TENANT_IDS.hospital,
      USER_IDS.admin,
      'Sample Admin',
      'admin@sample-hospital.test',
      'admin',
    ),
    signIn(
      TENANT_IDS.hospital,
      USER_IDS.doctor,
      'Sample Doctor',
      'doctor@sample-hospital.test',
      'doctor',
    ),
    signIn(
      TENANT_IDS.clinic,
      USER_IDS.doctor,
      'Sample Doctor',
      'doctor@sample-hospital.test',
      'doctor',
    ),
    signIn(
      TENANT_IDS.clinic,
      USER_IDS.receptionist,
      'Sample Receptionist',
      'reception@riverside-clinic.test',
      'receptionist',
    ),
  ];
  return { hospital, clinic, all };
}

function seed() {
  const members = seedStaffDirectory().all;
  // One person at the hospital who was deactivated, and two invitations still open.
  const left = members.find((member) => member.userId === 'stf_h_36');
  if (left) left.status = 'deactivated';
  const invites: MockInvite[] = [
    {
      id: 'inv_h_01',
      tenantId: TENANT_IDS.hospital,
      name: 'Invited Ira',
      email: 'ira@sample-hospital.test',
      roleId: 'doctor',
    },
    {
      id: 'inv_c_01',
      tenantId: TENANT_IDS.clinic,
      name: 'Invited Omar',
      email: 'omar@riverside-clinic.test',
      roleId: 'receptionist',
    },
  ];
  return {
    members,
    invites,
    created: 0,
    sent: [] as MockInvite[],
    replies: new Map<string, { raw: string; invite: Invite }>(),
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** The active members of a hospital, for the mocks of features that refer to staff. */
export const mockStaffOf = (tenantId: string): MockStaff[] =>
  state.members.filter((member) => member.tenantId === tenantId && member.status === 'active');

/** Every invitation "emailed" since the last reset, oldest first. */
export const mockInvitesSent = (): readonly MockInvite[] => state.sent;

/** A role's name as the hospital shows it. Roles have no names of their own in the mock. */
const roleName = (roleId: string) =>
  roleId.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const notFound = () => error(404, 'staff_not_found', 'No such member of staff');

const view = (member: MockStaff): StaffMember => ({
  id: member.userId,
  tenantId: member.tenantId,
  name: member.name,
  email: member.email,
  roleId: member.roleId,
  roleName: roleName(member.roleId),
  status: member.status,
});

/** Someone of another hospital does not exist as far as this session is concerned. */
const find = (tenantId: string, userId: unknown) =>
  state.members.find((member) => member.tenantId === tenantId && member.userId === userId);

/** Whether someone's role lets them manage staff: by what the role holds, never by its name. */
const managesStaff = (member: MockStaff) => mockRoleHolds(member.tenantId, member.roleId, MANAGE);

/**
 * Whether the signed-in person may give someone a role: it holds nothing they do not hold, at no
 * wider a scope. The API's rule (`grantsWithin`), so the picker offers what sending accepts.
 */
function mayGive(tenantId: string, roleId: string): boolean {
  const held = currentPolicy()?.permissions ?? [];
  return mockRoleGrants(tenantId, roleId).every((grant) => {
    const own = held.find((candidate) => candidate.permission === grant.permission);
    const ownScope = own?.scope ?? 'all';
    return own !== undefined && (ownScope === 'all' || ownScope === (grant.scope ?? 'all'));
  });
}

export const staffHandlers = [
  // Before the routes with a user id in the same place.
  http.get('*/api/staff/roles', ({ request }) => {
    const access = authorize(request, { permission: INVITE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const items = mockRoleIds(access.tenantId)
      .filter((id) => mayGive(access.tenantId, id))
      .map((id) => ({ id, name: roleName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return HttpResponse.json<StaffRoleList>({ items });
  }),

  http.get('*/api/staff', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const status = params.get('status') ?? 'active';
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 25), 1), 100);
    const cursor = params.get('cursor');
    // Tenant isolation: only people of the session's hospital are ever considered.
    const people: StaffMember[] =
      status === 'invited'
        ? state.invites
            .filter((invite) => invite.tenantId === access.tenantId)
            .map((invite) => ({
              id: invite.id,
              tenantId: invite.tenantId,
              name: invite.name,
              email: invite.email,
              roleId: invite.roleId,
              roleName: roleName(invite.roleId),
              status: 'invited',
            }))
        : state.members
            .filter((member) => member.tenantId === access.tenantId && member.status === status)
            .map(view);
    const visible = people
      .filter((person) => `${person.name} ${person.email}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const start = cursor ? visible.findIndex((person) => person.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<StaffPage>({
      items: visible.slice(start, start + limit),
      nextCursor: next?.id ?? null,
      total: visible.length,
    });
  }),

  http.post('*/api/staff/:userId/deactivate', ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const member = find(access.tenantId, params.userId);
    if (!member) return notFound();
    if (member.userId === currentSession()?.user.id) {
      return error(409, 'cannot_deactivate_self', 'You cannot deactivate yourself');
    }
    const otherAdmins = mockStaffOf(access.tenantId).filter(
      (other) => managesStaff(other) && other.userId !== member.userId,
    );
    if (member.status === 'active' && managesStaff(member) && otherAdmins.length === 0) {
      return error(409, 'last_admin', 'The hospital would have nobody to manage its staff');
    }
    // Doing it twice is harmless, so a retried request cannot fail.
    member.status = 'deactivated';
    return HttpResponse.json<StaffMember>(view(member));
  }),

  http.post('*/api/staff/:userId/reactivate', ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const member = find(access.tenantId, params.userId);
    if (!member) return notFound();
    member.status = 'active';
    return HttpResponse.json<StaffMember>(view(member));
  }),

  http.post('*/api/staff/:userId/revoke-sessions', ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!find(access.tenantId, params.userId)) return notFound();
    return HttpResponse.json({ revoked: 1 });
  }),

  // The real API has this one (features/staff). No feature flag there either.
  http.post('*/api/invites', async ({ request }) => {
    // No module switch, as in the real API: only the permission.
    const access = authorize(request, { permission: INVITE });
    if ('denied' in access) return access.denied;
    const raw = await request.text();
    // The same key with the same request is answered as before, and nothing is sent again.
    const key = `${access.tenantId}:${request.headers.get('idempotency-key') ?? ''}`;
    const earlier = state.replies.get(key);
    if (earlier && request.headers.get('idempotency-key')) {
      return earlier.raw === raw
        ? HttpResponse.json<Invite>(earlier.invite, {
            status: 201,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : error(422, 'idempotency_key_reuse', 'That key was used for another request');
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // Left as null: refused below.
    }
    const { email, name, roleId } =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (typeof email !== 'string' || typeof name !== 'string' || typeof roleId !== 'string') {
      return error(400, 'validation_failed', 'A name, an email and a role are required');
    }
    if (!EMAIL.test(email.trim()) || name.trim() === '' || name.length > 200) {
      return error(400, 'validation_failed', 'A name and one valid email are required');
    }
    if (!mockRoleIds(access.tenantId).includes(roleId)) {
      return error(400, 'unknown_role', 'No such role here');
    }
    if (!mayGive(access.tenantId, roleId)) {
      return error(403, 'role_not_allowed', 'That role holds more than you do');
    }
    const address = email.trim().toLowerCase();
    // A newer invite to the same address replaces an older one.
    state.invites = state.invites.filter(
      (invite) => !(invite.tenantId === access.tenantId && invite.email === address),
    );
    const invite: MockInvite = {
      id: `inv_new_${++state.created}`,
      tenantId: access.tenantId,
      name: name.trim(),
      email: address,
      roleId,
    };
    state.invites.push(invite);
    state.sent.push(invite);
    const reply: Invite = { id: invite.id, email: invite.email, roleId, expiresInHours: 168 };
    state.replies.set(key, { raw, invite: reply });
    return HttpResponse.json<Invite>(reply, { status: 201 });
  }),
];
