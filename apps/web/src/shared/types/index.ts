/**
 * Shared domain types (CLAUDE.md Domain Types). Entities owned by one feature are defined with
 * that feature; only types used across core and several features live here.
 */

// Roles are data, not a closed union: hospitals can create custom roles.
export type RoleId = string;

export const BuiltInRoles = {
  PlatformAdmin: 'platform_admin',
  Admin: 'admin',
  Doctor: 'doctor',
  Nurse: 'nurse',
  Receptionist: 'receptionist',
  Pharmacist: 'pharmacist',
  LabTechnician: 'lab_technician',
  Radiologist: 'radiologist',
  StoreKeeper: 'store_keeper',
} as const;

export type Permission = `${string}:${string}`; // 'resource:action'
export type PermissionScope = 'all' | 'own' | 'department';

export interface PermissionGrant {
  permission: Permission;
  scope?: PermissionScope;
}

export interface RoleDefinition {
  id: RoleId;
  tenantId: string | null; // null for platform-level roles
  name: string;
  builtIn: boolean;
  permissions: PermissionGrant[];
}

export interface AccessPolicy {
  tenantId: string;
  roleId: RoleId;
  permissions: PermissionGrant[];
  features: Record<string, boolean>; // tenant feature flags
  version: string; // for cache invalidation/refresh
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  locale: string; // e.g. 'en-IN'
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
  currency: string; // ISO 4217
  theme: { primary: string; logoUrl?: string };
  features: Record<string, boolean>;
  auth: { mode: 'password' | 'sso' };
  /** A suspended hospital keeps its data, but its staff cannot use the app. */
  status: 'active' | 'suspended';
}

export interface User {
  id: string;
  email: string;
  name: string;
  memberships: { tenantId: string; tenantName: string; roleId: RoleId }[];
}
