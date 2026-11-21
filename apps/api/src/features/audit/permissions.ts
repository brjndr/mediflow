import type { PermissionDefinition } from '../../core/access/registry.js';

/** The hospital's own audit trail is its admin's by default; a custom role can be given it. */
export const AUDIT_PERMISSIONS = [
  {
    id: 'auditLog:read',
    description: "Search the hospital's audit log: who did what to which record, and when",
    defaults: { admin: 'all' },
  },
  {
    id: 'auditLog:export',
    description:
      "Export the hospital's audit log as a stored report (also needs report:read and report:export)",
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
