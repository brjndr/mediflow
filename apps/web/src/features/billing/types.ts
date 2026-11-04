import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** Billable work posted to a visit, priced when it was posted (#109). */
export type Charge = Schemas['Charge'];
export type ChargePage = Schemas['ChargePage'];
/** A service of the price catalog charged to a visit by hand: the server sets the price. */
export type ChargeCreate = Schemas['ChargeCreate'];
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
/** A refund of some or all of one payment, with its reason (#444). */
export type RefundCreate = Schemas['RefundCreate'];
/** A credit note against an issued invoice, with its reason (#112). */
export type CreditNote = Schemas['CreditNote'];
export type CreditNoteCreate = Schemas['CreditNoteCreate'];
/** A cashier's drawer for a shift: opened with cash, settled with the cash counted (#118). */
export type RegisterSession = Schemas['RegisterSession'];
export type RegisterSessionPage = Schemas['RegisterSessionPage'];
export type RegisterTotal = Schemas['RegisterTotal'];
export type RegisterOpen = Schemas['RegisterOpen'];
export type RegisterClose = Schemas['RegisterClose'];
/** The hospital's tax rate for each tax class, in basis points (#119). */
export type TaxRates = Schemas['TaxRates'];
export type TaxRate = Schemas['TaxRate'];
export type TaxClass = TaxRate['taxClass'];
/** A discount on a line or on the whole bill, with its reason (#116). */
export type Discount = Schemas['Discount'];
export type ChargeDiscount = Schemas['ChargeDiscount'];
export type DiscountReason = Discount['reason'];
/** The most a bill may be discounted without approval, in basis points. */
export type DiscountSettings = Schemas['DiscountSettings'];
