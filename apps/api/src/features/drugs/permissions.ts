import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The drug and consumable master is reference data: those who prescribe, request, dispense and
 * store need to see what an item is, and the hospital's admin keeps the list.
 */
export const DRUG_PERMISSIONS = [
  {
    id: 'drug:read',
    description: 'See the medicines and consumables the hospital keeps',
    defaults: {
      admin: 'all',
      doctor: 'all',
      nurse: 'all',
      pharmacist: 'all',
      store_keeper: 'all',
    },
  },
  {
    id: 'drug:manage',
    description: 'Add, change, archive and restore medicines and consumables',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
