import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The "Billing and payments" row of `docs/PRODUCT.md`: the admin and the front desk work the
 * bill; a doctor sees charges and invoices. Refunds, credit notes and typed lines (which skip the
 * price list) are the admin's by default. The billing desk works the whole hospital's bills, so
 * only the scope `all` reaches anything.
 */
export const BILLING_PERMISSIONS = [
  {
    id: 'charge:read',
    description: 'See the charges posted to a visit, with the name and MRN of its patient',
    defaults: { admin: 'all', doctor: 'all', receptionist: 'all' },
  },
  {
    id: 'charge:create',
    description:
      'Charge a service of the price catalog to a visit by hand, at the price list’s price',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'invoice:read',
    description: 'See invoices, with the name and MRN of the patient, their lines and payments',
    defaults: { admin: 'all', doctor: 'all', receptionist: 'all' },
  },
  {
    id: 'invoice:create',
    description: 'Make a draft invoice of a visit from its pending charges, and change a draft',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'invoice:issue',
    description: 'Issue a draft invoice: it gets its number and is never changed after',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'invoice:print',
    description: 'Print an issued invoice (each print is recorded in the audit log)',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'invoice:adjust',
    description: 'Type in an invoice line that is not in the price list or the charge ledger',
    defaults: { admin: 'all' },
  },
  {
    id: 'payment:read',
    description: 'See the payments and refunds of an invoice',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'payment:create',
    description: 'Record a payment against an issued invoice',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'payment:refund',
    description: 'Refund a payment, with a reason',
    defaults: { admin: 'all' },
  },
  {
    id: 'creditNote:create',
    description: 'Issue a credit note against an issued invoice, with a reason',
    defaults: { admin: 'all' },
  },
  {
    id: 'cashRegister:read',
    description: 'See every cash register session and what each took, by method',
    defaults: { admin: 'all' },
  },
  {
    id: 'cashRegister:manage',
    description: 'Open a cash register session of one’s own and settle it at the end of the day',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'taxRate:manage',
    description: 'Set the hospital’s tax rate for each tax class',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
