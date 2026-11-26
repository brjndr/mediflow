import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { visibilityFor } from './http.js';
import {
  encounterOpenedFor,
  findEncounter,
  hasRecords,
  practisingDoctor,
  type EncounterRow,
} from './repository.js';
import { closeOpenVisit, openOpdVisit, refuseManagedElsewhere } from './visit.js';

/**
 * A visit kept on paper (#1202), for the documents module, which holds its scanned sheet. Every
 * function narrows to the scope the caller holds `permission` with, which the route declares.
 */

export interface PaperVisitRecord {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  type: string;
  status: EncounterRow['status'];
  queueTokenId: string | null;
  doctorName: string | null;
  openedAt: Date;
  version: number;
}

const record = (row: EncounterRow): PaperVisitRecord => ({
  id: row.id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  type: row.type,
  status: row.status,
  queueTokenId: row.queue_token_id,
  doctorName: row.attending_doctor_name,
  openedAt: row.opened_at,
  version: row.version,
});

export async function findPaperVisit(
  request: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<PaperVisitRecord | null> {
  const row = await findEncounter(request.txClient, id, visibilityFor(request, permission));
  return row ? record(row) : null;
}

interface PaperToken {
  id: string;
  patientId: string;
  doctorId: string | null;
  appointmentId: string | null;
}

/**
 * The visit, not cancelled, that a token or its appointment opened, or null. Two of them, or one
 * the caller does not reach, is 409 `already_open`: never handed out, as when opening.
 */
export async function findPaperVisitOfToken(
  request: FastifyRequest,
  token: PaperToken,
  permission: Permission,
): Promise<PaperVisitRecord | null> {
  const existing = await encounterOpenedFor(request.txClient, {
    queueTokenId: token.id,
    appointmentId: token.appointmentId,
  });
  if (existing.length === 0) return null;
  const [only] = existing;
  const visit =
    existing.length === 1 && only ? await findPaperVisit(request, only, permission) : null;
  if (!visit) throw new HttpError(409, 'already_open', 'An encounter exists for it');
  return visit;
}

/** Opens the token's visit under the token's doctor, or answers the one already there. */
export async function openPaperVisit(
  request: FastifyRequest,
  token: PaperToken,
  permission: Permission,
): Promise<PaperVisitRecord> {
  const existing = await findPaperVisitOfToken(request, token, permission);
  if (existing) return existing;
  if (!token.doctorId) {
    throw new HttpError(422, 'token_without_doctor', 'The token was issued for no doctor');
  }
  const doctor = await practisingDoctor(
    request.txClient,
    token.doctorId,
    visibilityFor(request, permission),
  );
  if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
  const id = await openOpdVisit(request, {
    patientId: token.patientId,
    queueTokenId: token.id,
    appointmentId: token.appointmentId,
    doctor,
  });
  const opened = await findPaperVisit(request, id, permission);
  if (!opened) throw new Error('encounter was not opened');
  return opened;
}

/**
 * Closes an open OPD visit with nothing written on it, at the version read. `requireSheet` runs once the row is locked and
 * throws when no sheet is on the visit.
 */
export async function closePaperVisit(
  request: FastifyRequest,
  { id, version }: { id: string; version: number },
  permission: Permission,
  requireSheet: () => Promise<void>,
): Promise<void> {
  const row = await findEncounter(
    request.txClient,
    id,
    visibilityFor(request, permission),
    'update',
  );
  if (!row) throw new HttpError(404, 'encounter_not_found', 'No such encounter');
  if (row.status !== 'open') {
    throw new HttpError(409, 'invalid_transition', `A ${row.status} encounter does not change`);
  }
  if (row.version !== version) {
    throw new HttpError(409, 'conflict', 'The encounter has changed since it was read');
  }
  await refuseManagedElsewhere(request, row);
  if (row.type !== 'opd') {
    throw new HttpError(409, 'not_opd_visit', 'Only an OPD visit is kept on paper');
  }
  // A visit written up on screen is the doctor's to close, never closed from the paper.
  if (await hasRecords(request.txClient, row.id)) {
    throw new HttpError(
      409,
      'has_records',
      'The visit has records: close it from the consultation',
    );
  }
  await requireSheet();
  await closeOpenVisit(request, row);
  request.audit('update', 'encounter', row.id);
}
