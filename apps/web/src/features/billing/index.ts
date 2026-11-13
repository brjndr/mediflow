// Public surface of the feature. Other features and core import from here only.
export { billingFeature } from './manifest';
export type { Charge, Invoice, InvoiceLine } from './types';
// Whether a stay's bill lets the patient be discharged under the hospital's policy (DS-04, #167).
export { useDischargeClearance } from './hooks/use-stay-bill';
export type { ClearanceReason } from './stay-bill';
