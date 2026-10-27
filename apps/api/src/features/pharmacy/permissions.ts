import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Pharmacy dispense and sales" row of `docs/PRODUCT.md`: the pharmacist
 * dispenses, sells at the counter and keeps the drug register (#101). The admin holds every one, as in the other modules: nobody invites into a role that
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
  {
    id: 'sale:read',
    description:
      'See the pharmacy’s counter sales, with the name and MRN of the patient when one was named, their lines, prices and returns, and print a receipt',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
  {
    id: 'sale:create',
    description:
      'Sell items at the counter from batches at a place, a scheduled item only against an outside prescription to a registered patient',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
  {
    id: 'sale:return',
    description: 'Bring units of a counter sale back into stock, with a reason',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
  {
    id: 'drugRegister:read',
    description:
      'See the drug register of a Schedule H1, X, narcotic or controlled item: every movement of its stock, with who each dispense or sale was for and who prescribed it',
    defaults: { admin: 'all', pharmacist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
