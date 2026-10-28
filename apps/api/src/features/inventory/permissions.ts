import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Inventory and purchasing" row of `docs/PRODUCT.md`: the store keeper keeps
 * the stock, the pharmacist sees it ("stock view"), and the admin holds every one, as in the
 * other modules: nobody invites into a role that holds more than their own. Asking for an
 * adjustment and approving one are apart, and nobody approves their own (the route and a check
 * constraint), so a store with one store keeper needs the admin to approve.
 */
export const INVENTORY_PERMISSIONS = [
  {
    id: 'stock:read',
    description:
      'See the stock of each item by batch and place, its alerts, the ledger, the adjustments and the places that keep stock',
    defaults: { admin: 'all', pharmacist: 'all', store_keeper: 'all' },
  },
  {
    id: 'stock:adjust',
    description: 'Ask for a stock adjustment, opening stock included, with a reason',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'stock:approve',
    description:
      'Approve or reject a stock adjustment someone else asked for; an approved one moves stock',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'stockLocation:manage',
    description: 'Add, rename, archive and restore the places that keep stock',
    defaults: { admin: 'all' },
  },
  // Indents (#105): the nurse indents for a ward ("indent" and "request/indent" in the matrix),
  // the pharmacist for the counter, and the store keeper approves and issues. Asking needs no
  // `stock:read`: a nurse sees an indent, not the hospital's stock.
  {
    id: 'indent:read',
    description: 'See the indents of every place, what was approved and issued, and their vouchers',
    defaults: { admin: 'all', nurse: 'all', pharmacist: 'all', store_keeper: 'all' },
  },
  {
    id: 'indent:create',
    description: 'Ask a store for items for a place (an indent), and cancel one you asked for',
    defaults: { admin: 'all', nurse: 'all', pharmacist: 'all', store_keeper: 'all' },
  },
  {
    id: 'indent:approve',
    description: 'Approve an indent someone else asked for, for up to what was asked, or reject it',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'indent:issue',
    description:
      'Issue an approved indent on vouchers, moving stock from the store to the place that asked, and close one short',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
