import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import { findAdmission } from './repository.js';

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
