import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * The pharmacy (#100): the queue of prescriptions to dispense, a prescription as the pharmacy
 * dispenses it (its lines and its dispenses), and what may be given for a line at a place. The
 * endpoints are the pharmacy API's.
 */
export type PharmacyQueueItem = Schemas['PharmacyQueueItem'];
export type PharmacyQueuePage = Schemas['PharmacyQueuePage'];
export type PharmacyPrescription = Schemas['PharmacyPrescription'];
export type PharmacyLine = Schemas['PharmacyLine'];
export type Dispense = Schemas['Dispense'];
export type DispenseBatch = Schemas['DispenseBatch'];
export type DispenseOptions = Schemas['DispenseOptions'];
export type DispensableItem = Schemas['DispensableItem'];
export type DispensableBatch = Schemas['DispensableBatch'];
export type DispenseCreate = Schemas['DispenseCreate'];
export type QueueState = 'open' | 'done';

/** Counter sales, their returns and the drug register (#101). */
export type SaleItemOptions = Schemas['SaleItemOptions'];
export type SaleCreate = Schemas['SaleCreate'];
export type PharmacySale = Schemas['PharmacySale'];
export type SaleLine = Schemas['SaleLine'];
export type SaleListItem = Schemas['SaleListItem'];
export type SalePage = Schemas['SalePage'];
export type SaleReturnCreate = Schemas['SaleReturnCreate'];
export type DrugRegisterEntry = Schemas['DrugRegisterEntry'];
export type DrugRegisterPage = Schemas['DrugRegisterPage'];
