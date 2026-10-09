import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];
type TenantDto = Schemas['Tenant'];
type PermissionGrantDto = Schemas['PermissionGrant'];
export type SessionDto = Schemas['Session'];
export type AccessPolicyDto = Schemas['AccessPolicy'];

/**
 * In-memory mock backend data. Synthetic only: never copy real hospital, staff or patient data
 * here. Two hospitals differ in locale, timezone, currency, theme and enabled modules, so tenant
 * isolation and tenant-aware formatting can be exercised without a backend.
 */
export const TENANT_IDS = { hospital: 'tenant_1', clinic: 'tenant_2' } as const;

const initialTenants: Record<string, TenantDto> = {
  [TENANT_IDS.hospital]: {
    id: TENANT_IDS.hospital,
    slug: 'sample-hospital',
    name: 'Sample Hospital',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    theme: { primary: 'oklch(0.52 0.1 180)' },
    features: {
      patients: true,
      appointments: true,
      clinical: true,
      laboratory: true,
      radiology: true,
      pharmacy: true,
      billing: true,
      reports: true,
      notices: true,
    },
    auth: { mode: 'password' },
  },
  // A small OPD clinic: diagnostics and pharmacy are switched off.
  [TENANT_IDS.clinic]: {
    id: TENANT_IDS.clinic,
    slug: 'riverside-clinic',
    name: 'Riverside Clinic',
    locale: 'en-GB',
    timezone: 'Asia/Dubai',
    currency: 'AED',
    theme: { primary: 'oklch(0.5 0.15 265)' },
    features: {
      patients: true,
      appointments: true,
      clinical: true,
      laboratory: false,
      radiology: false,
      pharmacy: false,
      billing: true,
      reports: false,
      notices: false,
    },
    auth: { mode: 'password' },
  },
};

const ADMIN: PermissionGrantDto[] = [
  { permission: 'patient:read' },
  { permission: 'patient:create' },
  { permission: 'patient:update' },
  { permission: 'patient:delete' },
  { permission: 'appointment:read' },
  { permission: 'appointment:create' },
  { permission: 'appointment:update' },
  { permission: 'clinical:read' },
  { permission: 'billing:read' },
  { permission: 'billing:create' },
  { permission: 'billing:refund' },
  { permission: 'report:read' },
  { permission: 'user:manage' },
  { permission: 'role:manage' },
  { permission: 'notice:read' },
  { permission: 'notice:manage' },
];

const DOCTOR: PermissionGrantDto[] = [
  { permission: 'patient:read' },
  { permission: 'patient:update' },
  { permission: 'appointment:read', scope: 'own' },
  { permission: 'clinical:read' },
  { permission: 'clinical:write' },
  { permission: 'order:create' },
  { permission: 'notice:read' },
  { permission: 'billing:read' },
  { permission: 'report:read', scope: 'own' },
];

/** Roles are per tenant: the same role id can carry different permissions in each hospital. */
const initialRoles: Record<string, Record<string, PermissionGrantDto[]>> = {
  [TENANT_IDS.hospital]: { admin: ADMIN, doctor: DOCTOR },
  [TENANT_IDS.clinic]: {
    admin: ADMIN,
    // This clinic's admin removed ordering and billing access from its doctors.
    doctor: DOCTOR.filter((grant) => !/^(order|billing):/.test(grant.permission)),
    receptionist: [
      { permission: 'patient:read' },
      { permission: 'patient:create' },
      { permission: 'patient:update' },
      { permission: 'appointment:read' },
      { permission: 'appointment:create' },
      { permission: 'appointment:update' },
      { permission: 'billing:read' },
      { permission: 'billing:create' },
    ],
    // A custom role created by the clinic.
    billing_clerk: [
      { permission: 'patient:read' },
      { permission: 'billing:read' },
      { permission: 'billing:create' },
    ],
  },
};

// Working copies: tests and the role management screens change them, resetMockDb restores them.
let tenants = structuredClone(initialTenants);
let roles = structuredClone(initialRoles);
/** Bumped on every access change so the policy version (and its ETag) changes with it. */
let revision = 1;

interface MockUser {
  id: string;
  email: string;
  name: string;
  memberships: { tenantId: string; roleId: string }[];
}

export const USER_IDS = {
  admin: 'user_admin',
  doctor: 'user_doctor',
  receptionist: 'user_receptionist',
  billingClerk: 'user_billing_clerk',
} as const;

const users: Record<string, MockUser> = {
  [USER_IDS.admin]: {
    id: USER_IDS.admin,
    email: 'admin@sample-hospital.test',
    name: 'Sample Admin',
    memberships: [{ tenantId: TENANT_IDS.hospital, roleId: 'admin' }],
  },
  // Works at both hospitals, so starts with no active tenant until one is picked.
  [USER_IDS.doctor]: {
    id: USER_IDS.doctor,
    email: 'doctor@sample-hospital.test',
    name: 'Sample Doctor',
    memberships: [
      { tenantId: TENANT_IDS.hospital, roleId: 'doctor' },
      { tenantId: TENANT_IDS.clinic, roleId: 'doctor' },
    ],
  },
  [USER_IDS.receptionist]: {
    id: USER_IDS.receptionist,
    email: 'reception@riverside-clinic.test',
    name: 'Sample Receptionist',
    memberships: [{ tenantId: TENANT_IDS.clinic, roleId: 'receptionist' }],
  },
  [USER_IDS.billingClerk]: {
    id: USER_IDS.billingClerk,
    email: 'billing@riverside-clinic.test',
    name: 'Sample Billing Clerk',
    memberships: [{ tenantId: TENANT_IDS.clinic, roleId: 'billing_clerk' }],
  },
};

/** The mock "server-side session": who is signed in and which hospital is active. */
interface MockSessionState {
  userId: string | null;
  activeTenantId: string | null;
}

const state: MockSessionState = { userId: null, activeTenantId: null };

/** Sign in as a mock user. A user with one hospital goes straight in; others have no tenant yet. */
export function signIn(userId: string, tenantId?: string): void {
  const user = users[userId];
  if (!user) throw new Error(`Unknown mock user: ${userId}`);
  const only = user.memberships.length === 1 ? user.memberships[0]?.tenantId : undefined;
  state.userId = userId;
  state.activeTenantId = tenantId ?? only ?? null;
}

export function signOut(): void {
  state.userId = null;
  state.activeTenantId = null;
}

const resetListeners: (() => void)[] = [];

/** Lets a feature's mock handlers restore their own data when the mock backend is reset. */
export function onMockReset(listener: () => void): void {
  resetListeners.push(listener);
}

/** The dev app and every test start signed in as the single-hospital admin. */
export function resetMockDb(): void {
  tenants = structuredClone(initialTenants);
  roles = structuredClone(initialRoles);
  revision = 1;
  signIn(USER_IDS.admin);
  for (const listener of resetListeners) listener();
}

export function isMockUser(userId: string): boolean {
  return userId in users;
}

function policyFor(user: MockUser, tenantId: string): AccessPolicyDto | null {
  const membership = user.memberships.find((m) => m.tenantId === tenantId);
  const tenant = tenants[tenantId];
  if (!membership || !tenant) return null;
  const permissions = roles[tenantId]?.[membership.roleId] ?? [];
  return {
    tenantId,
    roleId: membership.roleId,
    permissions,
    features: tenant.features,
    version: `${tenantId}.${membership.roleId}.${revision}`,
  };
}

export function currentPolicy(): AccessPolicyDto | null {
  const user = state.userId ? users[state.userId] : undefined;
  return user && state.activeTenantId ? policyFor(user, state.activeTenantId) : null;
}

export function activeTenantId(): string | null {
  return state.activeTenantId;
}

/** Null when nobody is signed in. */
export function currentSession(): SessionDto | null {
  const user = state.userId ? users[state.userId] : undefined;
  if (!user) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      memberships: user.memberships.map((m) => ({
        ...m,
        tenantName: tenants[m.tenantId]?.name ?? '',
      })),
    },
    activeTenant: state.activeTenantId ? (tenants[state.activeTenantId] ?? null) : null,
    policy: currentPolicy(),
  };
}

/** False when the signed-in user is not a member of that hospital. */
export function switchTenant(tenantId: string): boolean {
  const user = state.userId ? users[state.userId] : undefined;
  if (!user?.memberships.some((m) => m.tenantId === tenantId)) return false;
  state.activeTenantId = tenantId;
  return true;
}

/** What a hospital admin does on the role screen: replace the permissions of one role. */
export function setRolePermissions(
  tenantId: string,
  roleId: string,
  permissions: PermissionGrantDto[],
): void {
  roles[tenantId] = { ...roles[tenantId], [roleId]: permissions };
  revision++;
}

export function revokePermission(tenantId: string, roleId: string, permission: string): void {
  const current = roles[tenantId]?.[roleId] ?? [];
  setRolePermissions(
    tenantId,
    roleId,
    current.filter((grant) => grant.permission !== permission),
  );
}

/** What a platform admin does: turn a module on or off for one hospital. */
export function setTenantFeature(tenantId: string, flag: string, enabled: boolean): void {
  const tenant = tenants[tenantId];
  if (!tenant) throw new Error(`Unknown mock tenant: ${tenantId}`);
  tenant.features = { ...tenant.features, [flag]: enabled };
  revision++;
}

/** What a platform admin does: change a hospital's locale, which drives the UI language. */
export function setTenantLocale(tenantId: string, locale: string): void {
  const tenant = tenants[tenantId];
  if (!tenant) throw new Error(`Unknown mock tenant: ${tenantId}`);
  tenant.locale = locale;
}

/** The session a mock user would get, without changing who is signed in. For test fixtures. */
export function sessionFor(userId: string, tenantId?: string): SessionDto {
  const previous = { ...state };
  signIn(userId, tenantId);
  const session = currentSession();
  Object.assign(state, previous);
  if (!session) throw new Error(`Unknown mock user: ${userId}`);
  return session;
}

resetMockDb();
