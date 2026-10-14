import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The import centre loads many records at once from a file: the hospital's admin, by default.
 * Loading a kind also needs that kind's own permission (`service:manage`, `patient:import`...),
 * so the centre never lets anyone add what they could not add one at a time.
 */
export const IMPORT_PERMISSIONS = [
  {
    id: 'import:read',
    description: 'See the batches loaded from files and their reports',
    defaults: { admin: 'all' },
  },
  {
    id: 'import:run',
    description: 'Load records from a file, check them and write them',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
