import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Pharmacy dispense and sales" row of `docs/PRODUCT.md`: the pharmacist
 * dispenses. The admin holds every one, as in the other modules: nobody invites into a role that
 * holds more than their own. The pharmacy works the whole hospital's prescriptions, so only the
 * scope `all` reaches anything.
 */
export const PHARMACY_PERMISSIONS = [
  {
    id: 'dispense:read',
    description:
      'See the pharmacy’s queue of prescriptions, with the name and MRN of each patient, their lines and what was dispensed, and print a dispense slip',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
  {
    id: 'dispense:create',
    description:
      'Dispense medicines against a prescription from batches at a place, in full or in part, with a generic substitute, and complete a line',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
