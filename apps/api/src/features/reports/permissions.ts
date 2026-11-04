import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Reports cover the whole hospital (money, stock, turnaround), so they are the admin's by
 * default; a custom role can be given them. Both need the scope `all`.
 */
export const REPORT_PERMISSIONS = [
  {
    id: 'report:read',
    description: 'Run the operational reports and see the stored ones and the hospital limits',
    defaults: { admin: 'all' },
  },
  {
    id: 'report:export',
    description: 'Ask for a stored report with a file to download, and get its download link',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
