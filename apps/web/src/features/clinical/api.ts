import { api, requireData } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import {
  diagnosisPageSchema,
  diagnosisSchema,
  encounterPageSchema,
  encounterSchema,
  notePageSchema,
  noteSchema,
  orderPageSchema,
  orderSchema,
  prescriptionPageSchema,
  prescriptionSchema,
  referralPageSchema,
  referralSchema,
} from './schemas';
import type {
  ClinicalNote,
  ClinicalNotePage,
  Diagnosis,
  DiagnosisCreate,
  DiagnosisPage,
  Encounter,
  EncounterCreate,
  EncounterPage,
  EncounterStatus,
  EncounterType,
  Order,
  OrderCreate,
  OrderPage,
  Prescription,
  PrescriptionCreate,
  PrescriptionPage,
  Referral,
  ReferralCreate,
  ReferralPage,
} from './types';

// Every address holds ids only: nothing about the patient is in a URL. Every POST carries an
// idempotency key, which the API requires; saving and discarding a draft go by its version.

export interface EncounterFilters {
  /** One patient's encounters: the clinical timeline (#83). */
  patientId?: string;
  attendingDoctorId?: string;
  status: EncounterStatus | '';
  type?: EncounterType | '';
}

export async function fetchEncounters(
  {
    patientId,
    attendingDoctorId,
    status,
    type,
    cursor,
    limit,
  }: EncounterFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<EncounterPage> {
  const result = await api.GET('/encounters', {
    params: {
      query: {
        patientId: patientId || undefined,
        attendingDoctorId: attendingDoctorId || undefined,
        status: status || undefined,
        type: type || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return encounterPageSchema.parse(requireData(result));
}

export async function fetchEncounter(
  encounterId: string,
  signal?: AbortSignal,
): Promise<Encounter> {
  const result = await api.GET('/encounters/{encounterId}', {
    params: { path: { encounterId } },
    signal,
  });
  return encounterSchema.parse(requireData(result));
}

/**
 * Opens the consultation from a token or an appointment. The answer is the encounter, whether it
 * was opened now (201) or was already open for that token or appointment (200).
 */
export async function openEncounter(
  body: EncounterCreate,
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return encounterSchema.parse(requireData(result));
}

export async function closeEncounter(
  encounterId: string,
  version: number,
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters/{encounterId}/close', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return encounterSchema.parse(requireData(result));
}

export async function cancelEncounter(
  encounterId: string,
  body: { version: number; reason: string },
  idempotencyKey: string,
): Promise<Encounter> {
  const result = await api.POST('/encounters/{encounterId}/cancel', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return encounterSchema.parse(requireData(result));
}

/** The signed notes, amendments included, and the caller's own drafts, oldest first. */
export async function fetchNotes(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ClinicalNotePage> {
  const result = await api.GET('/encounters/{encounterId}/notes', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return notePageSchema.parse(requireData(result));
}

export async function fetchNote(noteId: string, signal?: AbortSignal): Promise<ClinicalNote> {
  const result = await api.GET('/notes/{noteId}', { params: { path: { noteId } }, signal });
  return noteSchema.parse(requireData(result));
}

/** Starts a draft on the server. A draft is never kept in the browser. */
export async function createNote(
  encounterId: string,
  body: RichTextDocument,
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/encounters/{encounterId}/notes', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body: { body: { ...body } },
  });
  return noteSchema.parse(requireData(result));
}

/** Saves the draft whole, from the version the edit started from: another one is 409. */
export async function saveNote(
  noteId: string,
  body: RichTextDocument,
  version: number,
): Promise<ClinicalNote> {
  const result = await api.PATCH('/notes/{noteId}', {
    params: { path: { noteId } },
    body: { body: { ...body }, version },
  });
  return noteSchema.parse(requireData(result));
}

export async function discardNote(noteId: string): Promise<void> {
  // A refusal is thrown by the client; a 204 has no body to read.
  await api.DELETE('/notes/{noteId}', { params: { path: { noteId } } });
}

export async function signNote(
  noteId: string,
  version: number,
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/notes/{noteId}/sign', {
    params: { path: { noteId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return noteSchema.parse(requireData(result));
}

/** A new signed note with the whole corrected text, naming the note it amends. */
export async function amendNote(
  noteId: string,
  body: { body: RichTextDocument; reason: string },
  idempotencyKey: string,
): Promise<ClinicalNote> {
  const result = await api.POST('/notes/{noteId}/amendments', {
    params: { path: { noteId }, header: { 'idempotency-key': idempotencyKey } },
    body: { body: { ...body.body }, reason: body.reason },
  });
  return noteSchema.parse(requireData(result));
}

export async function fetchDiagnoses(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<DiagnosisPage> {
  const result = await api.GET('/encounters/{encounterId}/diagnoses', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return diagnosisPageSchema.parse(requireData(result));
}

export async function recordDiagnosis(
  encounterId: string,
  body: DiagnosisCreate,
  idempotencyKey: string,
): Promise<Diagnosis> {
  const result = await api.POST('/encounters/{encounterId}/diagnoses', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return diagnosisSchema.parse(requireData(result));
}

export async function retractDiagnosis(
  diagnosisId: string,
  reason: string,
  idempotencyKey: string,
): Promise<Diagnosis> {
  const result = await api.POST('/diagnoses/{diagnosisId}/retract', {
    params: { path: { diagnosisId }, header: { 'idempotency-key': idempotencyKey } },
    body: { reason },
  });
  return diagnosisSchema.parse(requireData(result));
}

/** The encounter's prescriptions with their lines, oldest first, replaced ones included. */
export async function fetchPrescriptions(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PrescriptionPage> {
  const result = await api.GET('/encounters/{encounterId}/prescriptions', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return prescriptionPageSchema.parse(requireData(result));
}

/**
 * Writes a prescription, never changed after. A revision is a new one naming the one it replaces
 * (`replacesId`, with a reason): the server cancels the old one's lines not yet started.
 */
export async function writePrescription(
  encounterId: string,
  body: PrescriptionCreate,
  idempotencyKey: string,
): Promise<Prescription> {
  const result = await api.POST('/encounters/{encounterId}/prescriptions', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return prescriptionSchema.parse(requireData(result));
}

/** One prescription with its lines as they are now. */
export async function fetchPrescription(
  prescriptionId: string,
  signal?: AbortSignal,
): Promise<Prescription> {
  const result = await api.GET('/prescriptions/{prescriptionId}', {
    params: { path: { prescriptionId } },
    signal,
  });
  return prescriptionSchema.parse(requireData(result));
}

/** Records that the visit summary is printed (#89): an audit entry, nothing else. */
export async function recordSummaryPrint(encounterId: string, idempotencyKey: string) {
  await api.POST('/encounters/{encounterId}/print', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
  });
}

/** Records that a prescription is printed (#89): an audit entry, nothing else. */
export async function recordPrescriptionPrint(prescriptionId: string, idempotencyKey: string) {
  await api.POST('/prescriptions/{prescriptionId}/print', {
    params: { path: { prescriptionId }, header: { 'idempotency-key': idempotencyKey } },
  });
}

/** At most this many pages of one list for a printed summary: far beyond any OPD visit. */
const SUMMARY_PAGES_MAX = 20;

/**
 * Every page of a list, read for a printed summary, which must leave nothing out. A cursor that
 * comes back again, or more pages than any visit has, is refused rather than read for ever.
 */
async function everyPage<Item>(
  read: (cursor: string | undefined) => Promise<{ items: Item[]; nextCursor?: string | null }>,
): Promise<Item[]> {
  const items: Item[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (seen.size >= SUMMARY_PAGES_MAX) throw new Error('summary_too_long');
    if (cursor !== undefined) seen.add(cursor);
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined && seen.has(cursor)) throw new Error('summary_cursor_repeated');
  } while (cursor !== undefined);
  return items;
}

export interface VisitSummary {
  notes?: ClinicalNote[];
  diagnoses?: Diagnosis[];
  prescriptions?: Prescription[];
}

/**
 * What the printed visit summary shows, read whole and afresh: the notes, diagnoses and
 * prescriptions, each only when asked for (the caller's permissions decide).
 */
export async function fetchVisitSummary(
  encounterId: string,
  parts: { notes: boolean; diagnoses: boolean; prescriptions: boolean },
  signal?: AbortSignal,
): Promise<VisitSummary> {
  const limit = 100;
  const [notes, diagnoses, prescriptions] = await Promise.all([
    parts.notes
      ? everyPage((cursor) => fetchNotes({ encounterId, cursor, limit }, signal))
      : undefined,
    parts.diagnoses
      ? everyPage((cursor) => fetchDiagnoses({ encounterId, cursor, limit }, signal))
      : undefined,
    parts.prescriptions
      ? everyPage((cursor) => fetchPrescriptions({ encounterId, cursor, limit }, signal))
      : undefined,
  ]);
  return {
    ...(notes ? { notes } : {}),
    ...(diagnoses ? { diagnoses } : {}),
    ...(prescriptions ? { prescriptions } : {}),
  };
}

/** The encounter's orders of one type, oldest first, cancelled ones included (#82). */
export async function fetchOrders(
  {
    encounterId,
    type,
    cursor,
    limit,
  }: { encounterId: string; type: Order['type']; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<OrderPage> {
  const result = await api.GET('/encounters/{encounterId}/orders', {
    params: { path: { encounterId }, query: { type, cursor, limit } },
    signal,
  });
  return orderPageSchema.parse(requireData(result));
}

/** Places one order; the module that does the work acts on it from `order.placed`. */
export async function placeOrder(
  encounterId: string,
  body: OrderCreate,
  idempotencyKey: string,
): Promise<Order> {
  const result = await api.POST('/encounters/{encounterId}/orders', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return orderSchema.parse(requireData(result));
}

/** Cancels an order not yet started, from the version shown, with a reason. */
export async function cancelOrder(
  orderId: string,
  body: { version: number; reason: string },
  idempotencyKey: string,
): Promise<Order> {
  const result = await api.POST('/orders/{orderId}/cancel', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return orderSchema.parse(requireData(result));
}

/** The encounter's referrals, oldest first, cancelled ones included (#88). */
export async function fetchReferrals(
  { encounterId, cursor, limit }: { encounterId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ReferralPage> {
  const result = await api.GET('/encounters/{encounterId}/referrals', {
    params: { path: { encounterId }, query: { cursor, limit } },
    signal,
  });
  return referralPageSchema.parse(requireData(result));
}

export async function createReferral(
  encounterId: string,
  body: ReferralCreate,
  idempotencyKey: string,
): Promise<Referral> {
  const result = await api.POST('/encounters/{encounterId}/referrals', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return referralSchema.parse(requireData(result));
}

export async function cancelReferral(
  referralId: string,
  reason: string,
  idempotencyKey: string,
): Promise<Referral> {
  const result = await api.POST('/referrals/{referralId}/cancel', {
    params: { path: { referralId }, header: { 'idempotency-key': idempotencyKey } },
    body: { reason },
  });
  return referralSchema.parse(requireData(result));
}
