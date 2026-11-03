import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** Billable work posted to a visit, priced when it was posted (#109). */
export type Charge = Schemas['Charge'];
export type ChargePage = Schemas['ChargePage'];
/** A line typed in by the billing desk: something not in the price catalog. */
export type ManualLine = Schemas['ManualLine'];
export type InvoiceLine = Schemas['InvoiceLine'];
export type Invoice = Schemas['Invoice'];
export type InvoicePage = Schemas['InvoicePage'];
/** What a draft is made of: pending charges of the visit and the lines typed in. */
export type InvoiceContent = Schemas['InvoiceContent'];
export type InvoiceUpdate = Schemas['InvoiceUpdate'];
/** A payment taken against an issued invoice, or a refund of one (#111). */
export type Payment = Schemas['Payment'];
export type PaymentMethod = Payment['method'];
export type PaymentCreate = Schemas['PaymentCreate'];
/** A credit note against an issued invoice, with its reason (#112). */
export type CreditNote = Schemas['CreditNote'];
export type CreditNoteCreate = Schemas['CreditNoteCreate'];
