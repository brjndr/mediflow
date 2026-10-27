import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The defaults of the "Inventory and purchasing" row of `docs/PRODUCT.md`: the store keeper buys
 * and receives. The admin holds every one, as in the other modules: nobody invites into a role
 * that holds more than their own, and a store with one store keeper needs the admin to approve
 * its orders. No patient data anywhere, so only the scope `all` reaches anything.
 */
export const PURCHASING_PERMISSIONS = [
  {
    id: 'supplier:read',
    description:
      'See the hospital’s suppliers, with their tax and drug licence numbers and contacts',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'supplier:manage',
    description: 'Add, edit, archive and restore suppliers',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'purchaseOrder:read',
    description:
      'See purchase orders with their lines and costs, the goods received against them and the goods returned',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'purchaseOrder:create',
    description:
      'Draft a purchase order, change it while it is a draft, submit it for approval, cancel it, and close one partly received',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'purchaseOrder:approve',
    description: 'Approve a purchase order someone else submitted',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'goodsReceipt:create',
    description:
      'Receive goods against an approved purchase order: batches, expiry dates and costs come into stock',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
  {
    id: 'purchaseReturn:create',
    description: 'Send units of received goods back to the supplier, expired ones included',
    defaults: { admin: 'all', store_keeper: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
