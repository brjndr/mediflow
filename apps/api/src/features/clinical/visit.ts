import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { userIdOf } from './http.js';
import {
  endEncounter,
  hasDrafts,
  hasRecords,
  insertEncounter,
  type EncounterRow,
  type NewEncounter,
} from './repository.js';

/** Opening, closing and cancelling a visit, the same however it is asked for. */

/** Inserts the OPD encounter, audits it and emits `encounter.opened`. */
export async function openOpdVisit(request: FastifyRequest, visit: NewEncounter): Promise<string> {
  let id: string;
  try {
    id = await insertEncounter(request.txClient, visit, userIdOf(request));
  } catch (error) {
    const { code } = (error ?? {}) as { code?: unknown };
    if (code === '23505') {
      throw new HttpError(409, 'already_open', 'An encounter exists for it');
    }
    throw error;
  }
  request.audit('create', 'encounter', id);
  await request.emit('encounter.opened', id, {
    encounterId: id,
    patientId: visit.patientId,
    type: 'opd',
    doctorId: visit.doctor.id,
    departmentId: visit.doctor.department_id,
    ...(visit.queueTokenId === null ? {} : { queueTokenId: visit.queueTokenId }),
    ...(visit.appointmentId === null ? {} : { appointmentId: visit.appointmentId }),
  });
  return id;
}

/** An admission's stay and an emergency case are ended by their own modules. */
export async function refuseManagedElsewhere(
  request: FastifyRequest,
  row: EncounterRow,
): Promise<void> {
  // The stay of an admission ends with its discharge (BE-23), not from here.
  const { rowCount } = await request.txClient.query(
    'select 1 from admissions where encounter_id = $1',
    [row.id],
  );
  if (rowCount) {
    throw new HttpError(409, 'managed_by_admission', 'The admission ends this encounter');
  }
  // So is the emergency department's, ended by the disposition (ER-02).
  if (row.type === 'er') {
    throw new HttpError(409, 'managed_by_emergency', 'The disposition ends this encounter');
  }
}

/** Closes an open encounter whose row is locked, unless a note of it is a draft. */
export async function closeOpenVisit(request: FastifyRequest, row: EncounterRow): Promise<void> {
  if (await hasDrafts(request.txClient, row.id)) {
    throw new HttpError(409, 'unsigned_notes', 'A note of the encounter is a draft');
  }
  await endEncounter(request.txClient, row.id, 'closed', userIdOf(request), null);
  await request.emit('encounter.closed', row.id, {
    encounterId: row.id,
    patientId: row.patient_id,
    ...(row.appointment_id === null ? {} : { appointmentId: row.appointment_id }),
  });
}

/**
 * Cancels an open encounter whose row is locked, unless a note of it is a draft or anything of it
 * is on the record. `requireEmpty` runs after those and throws for what else stands in the way.
 */
export async function cancelOpenVisit(
  request: FastifyRequest,
  row: EncounterRow,
  reason: string,
  requireEmpty?: () => Promise<void>,
): Promise<void> {
  // Drafts too: a cancelled encounter's draft could never be signed.
  if (await hasDrafts(request.txClient, row.id)) {
    throw new HttpError(409, 'unsigned_notes', 'A note of the encounter is a draft');
  }
  if (await hasRecords(request.txClient, row.id)) {
    throw new HttpError(409, 'has_records', 'The encounter has records');
  }
  await requireEmpty?.();
  await endEncounter(request.txClient, row.id, 'cancelled', userIdOf(request), reason);
  await request.emit('encounter.cancelled', row.id, {
    encounterId: row.id,
    patientId: row.patient_id,
  });
}
