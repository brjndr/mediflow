import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import { findAdmission, listAdmissions } from './repository.js';

/** The part of an admission that ward records need. */
export interface Stay {
  id: string;
  patientId: string;
  encounterId: string;
  departmentId: string;
  status: 'admitted' | 'discharged' | 'cancelled';
  version: number;
}

/**
 * For nursing: an admission the caller may reach with a permission held at `scope` (`own`: the
 * admissions they made as a doctor; `department`: those of their department), or null for one
 * that is out of scope, another hospital's or none. `forUpdate` locks the admission row.
 */
export async function stayInScope(
  client: pg.ClientBase,
  id: string,
  visibility: { scope: PermissionScope; userId: string },
  options: { forUpdate?: boolean } = {},
): Promise<Stay | null> {
  const row = await findAdmission(client, id, visibility, options);
  return row
    ? {
        id: row.id,
        patientId: row.patient_id,
        encounterId: row.encounter_id,
        departmentId: row.department_id,
        status: row.status,
        version: row.version,
      }
    : null;
}

/** A patient now in the hospital and where, for ward lists (the kitchen list, #161). */
export interface AdmittedStay {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  encounterId: string;
  wardId: string | null;
  wardName: string | null;
  roomName: string | null;
  bedNumber: string | null;
  admittedAt: Date;
}

/**
 * For nursing: one page of the stays that are admitted, optionally of one ward (the ward of the
 * bed now), within the scope the caller holds the permission with. Null for a bad cursor.
 */
export async function admittedStays(
  client: pg.ClientBase,
  filter: { wardId?: string; cursor?: string; limit: number },
  visibility: { scope: PermissionScope; userId: string },
): Promise<{ rows: AdmittedStay[]; nextCursor: string | null } | null> {
  const page = await listAdmissions(client, { ...filter, status: 'admitted' }, visibility);
  if (!page) return null;
  return {
    nextCursor: page.nextCursor,
    rows: page.rows.map((row) => ({
      id: row.id,
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientMrn: row.patient_mrn,
      encounterId: row.encounter_id,
      wardId: row.ward_id,
      wardName: row.ward_name,
      roomName: row.room_name,
      bedNumber: row.bed_number,
      admittedAt: row.admitted_at,
    })),
  };
}
