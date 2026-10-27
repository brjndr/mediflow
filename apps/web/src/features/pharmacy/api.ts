import { api, requireData } from '@/shared/api';
import { dispenseSchema, optionsSchema, prescriptionSchema, queuePageSchema } from './schemas';
import type {
  Dispense,
  DispenseCreate,
  DispenseOptions,
  PharmacyPrescription,
  PharmacyQueuePage,
  QueueState,
} from './types';

// Every address holds ids, a state and a number of days only: nothing about the patient is in a
// URL. Every POST carries an idempotency key, which the API requires.

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export interface QueueFilters {
  state: QueueState;
  days: number;
}

/** The queue: open prescriptions the oldest first, done ones the newest first. */
export async function fetchQueue(
  { state, days, cursor, limit }: QueueFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PharmacyQueuePage> {
  const result = await api.GET('/pharmacy/queue', {
    params: { query: { state, days, cursor, limit } },
    signal,
  });
  return queuePageSchema.parse(requireData(result));
}

export async function fetchPrescription(
  prescriptionId: string,
  signal?: AbortSignal,
): Promise<PharmacyPrescription> {
  const result = await api.GET('/pharmacy/prescriptions/{prescriptionId}', {
    params: { path: { prescriptionId } },
    signal,
  });
  return prescriptionSchema.parse(requireData(result));
}

/** What may be given for a line at a place: the medicine and its substitutes with their batches. */
export async function fetchOptions(
  orderId: string,
  locationId: string,
  signal?: AbortSignal,
): Promise<DispenseOptions> {
  const result = await api.GET('/pharmacy/orders/{orderId}/options', {
    params: { path: { orderId }, query: { locationId } },
    signal,
  });
  return optionsSchema.parse(requireData(result));
}

export async function createDispense(body: DispenseCreate, key: string): Promise<Dispense> {
  const result = await api.POST('/pharmacy/dispenses', { body, params: idempotent(key) });
  return dispenseSchema.parse(requireData(result));
}

/** Completes a line in progress when nothing more will be given. */
export async function completeLine(
  orderId: string,
  expectedVersion: number,
  key: string,
): Promise<PharmacyPrescription> {
  const result = await api.POST('/pharmacy/orders/{orderId}/complete', {
    params: { path: { orderId }, ...idempotent(key) },
    body: { expectedVersion },
  });
  return prescriptionSchema.parse(requireData(result));
}

/** Records that a dispense slip is printed: the page prints only once this is answered. */
export async function recordSlipPrint(dispenseId: string, key: string): Promise<void> {
  await api.POST('/pharmacy/dispenses/{dispenseId}/print', {
    params: { path: { dispenseId }, ...idempotent(key) },
  });
}
