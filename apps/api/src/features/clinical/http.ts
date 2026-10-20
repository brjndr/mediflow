import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { isEmptyRichText, sanitizeRichText } from '../../core/http/rich-text.js';
import { credentialsOf, type Credentials } from '../doctors/index.js';
import {
  findEncounter,
  type DiagnosisRow,
  type EncounterRow,
  type NoteRow,
  type OrderRow,
  type PrescriptionRow,
  type Visibility,
} from './repository.js';

/** What the routes of the module share: who is asking, the encounter they reach, the views. */

export const FEATURE = 'clinical';

export const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
export const encounterNotFound = () =>
  new HttpError(404, 'encounter_not_found', 'No such encounter');

export const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

export const visibilityFor = (request: FastifyRequest, permission: Permission): Visibility => ({
  scope: request.access.scope(permission),
  userId: userIdOf(request),
});

/**
 * The encounter, within the scope the caller holds `permission` with; otherwise the same 404 as
 * one of another hospital. `open` locks it (shared) and requires it open, so it cannot close
 * while something is added to it.
 */
export async function encounterFor(
  request: FastifyRequest,
  id: string,
  permission: Permission,
  { open = false }: { open?: boolean } = {},
): Promise<EncounterRow> {
  const row = await findEncounter(
    request.txClient,
    id,
    visibilityFor(request, permission),
    open ? 'share' : undefined,
  );
  if (!row) throw encounterNotFound();
  if (open && row.status !== 'open') {
    throw new HttpError(409, 'encounter_not_open', `The encounter is ${row.status}`);
  }
  return row;
}

/** A note's text: the app's rich text document, reduced to its allowlist, never empty. */
export function noteBody(value: unknown) {
  const body = sanitizeRichText(value);
  if (isEmptyRichText(body)) throw invalid('body: the note is empty');
  return body;
}

const optional = <Key extends string, Value>(key: Key, value: Value | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<Key, Value>>;
const instant = (value: Date | null) => (value === null ? null : value.toISOString());

const credentialsView = (credentials: Credentials | undefined) =>
  credentials === undefined
    ? null
    : {
        ...optional('qualifications', credentials.qualifications),
        ...optional('registrationNumber', credentials.registrationNumber),
        ...optional('registrationCouncil', credentials.registrationCouncil),
      };

/** The encounters as answered, each with its attending doctor's credentials, read at once. */
export async function encounterViews(client: pg.ClientBase, rows: EncounterRow[]) {
  const credentials = await credentialsOf(
    client,
    'doctor',
    rows.flatMap((row) => (row.attending_doctor_id === null ? [] : [row.attending_doctor_id])),
  );
  return rows.map((row) =>
    encounterView(
      row,
      row.attending_doctor_id === null ? undefined : credentials.get(row.attending_doctor_id),
    ),
  );
}

export const encounterAnswer = async (client: pg.ClientBase, row: EncounterRow) => {
  const [view] = await encounterViews(client, [row]);
  if (!view) throw new Error('no encounter view');
  return view;
};

const encounterView = (row: EncounterRow, credentials: Credentials | undefined) => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  type: row.type,
  status: row.status,
  ...optional('appointmentId', row.appointment_id),
  ...optional('queueTokenId', row.queue_token_id),
  ...optional('attendingDoctorId', row.attending_doctor_id),
  ...optional('attendingDoctorName', row.attending_doctor_name),
  ...optional('attendingDoctorCredentials', credentialsView(credentials)),
  ...optional('departmentId', row.department_id),
  ...optional('departmentName', row.department_name),
  openedAt: row.opened_at.toISOString(),
  openedByName: row.opened_by_name,
  ...optional('endedAt', instant(row.ended_at)),
  ...optional('endedByName', row.ended_by_name),
  ...optional('cancelReason', row.cancel_reason),
  version: row.version,
});

export const noteView = (row: NoteRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  status: row.status,
  // Reduced again on the way out, as everything rich text is.
  body: sanitizeRichText(row.body) as unknown as Record<string, unknown>,
  authorId: row.author_id,
  authorName: row.author_name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  ...optional('signedAt', instant(row.signed_at)),
  ...optional('amendsId', row.amends_id),
  ...optional('amendmentReason', row.amendment_reason),
  ...optional('amendedById', row.amended_by_id),
  version: row.version,
});

export const diagnosisView = (row: DiagnosisRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  ...optional('codeId', row.code_id),
  ...optional('code', row.code),
  ...optional('codeTitle', row.code_title),
  ...optional('text', row.text),
  kind: row.kind,
  recordedAt: row.recorded_at.toISOString(),
  recordedByName: row.recorded_by_name,
  ...optional('retractedAt', instant(row.retracted_at)),
  ...optional('retractedByName', row.retracted_by_name),
  ...optional('retractionReason', row.retraction_reason),
});

export const orderView = (row: OrderRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  type: row.type,
  ...optional('labTestId', row.lab_test_id),
  ...optional('serviceId', row.service_id),
  ...optional('drugId', row.drug_id),
  ...optional('prescriptionId', row.prescription_id),
  ...optional('lineNumber', row.line_number),
  ...optional('itemCode', row.item_code),
  ...optional('itemName', row.item_name),
  status: row.status,
  priority: row.priority,
  ...optional('instructions', row.instructions),
  ...optional('dose', row.dose),
  ...optional('route', row.route),
  ...optional('frequency', row.frequency),
  ...optional('durationDays', row.duration_days),
  ...optional('quantity', row.quantity),
  placedAt: row.placed_at.toISOString(),
  orderedById: row.ordered_by,
  orderedByName: row.ordered_by_name,
  ...optional('statusChangedAt', instant(row.status_changed_at)),
  ...optional('cancelReason', row.cancel_reason),
  version: row.version,
});

/** The prescribers' credentials, by user id, for `prescriptionView`. */
export const prescriberCredentials = (client: pg.ClientBase, rows: PrescriptionRow[]) =>
  credentialsOf(
    client,
    'user',
    rows.map((row) => row.prescribed_by),
  );

export const prescriptionView = (
  row: PrescriptionRow,
  lines: OrderRow[],
  credentials: Map<string, Credentials>,
) => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  prescribedAt: row.prescribed_at.toISOString(),
  prescribedById: row.prescribed_by,
  prescribedByName: row.prescribed_by_name,
  ...optional('prescribedByCredentials', credentialsView(credentials.get(row.prescribed_by))),
  ...optional('advice', row.advice),
  ...optional('replacesId', row.replaces_id),
  ...optional('replaceReason', row.replace_reason),
  ...optional('replacedById', row.replaced_by_id),
  lines: lines.filter((line) => line.prescription_id === row.id).map(orderView),
});

/** The payload of an `order.*` event: ids and codes, never the instructions or the dose. */
export const orderEvent = (row: OrderRow) => ({
  orderId: row.id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  type: row.type,
  ...optional('labTestId', row.lab_test_id),
  ...optional('serviceId', row.service_id),
  ...optional('drugId', row.drug_id),
  ...optional('prescriptionId', row.prescription_id),
  priority: row.priority,
});

/** A refusal for a unique index of the module, read by its name, or the error itself. */
export function uniqueRefusal(error: unknown, refusals: Record<string, HttpError>): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23505' && typeof constraint === 'string' && constraint in refusals) {
    return refusals[constraint];
  }
  return error;
}
