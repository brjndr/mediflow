import type pg from 'pg';
import { withPlatformTransaction } from '../../core/platform/db.js';
import { endHospitalSessions, recordPlatformAudit, withdrawOpenInvites } from './repository.js';

export const OFFBOARD_JOB = 'platform.offboard';

/** Ids only: the queue's own table has no row-level security. */
export interface OffboardJob {
  hospitalId: string;
  requestedBy: string;
}

/**
 * The sweep that follows an offboarding request. The request itself closes the hospital, withdraws
 * its open invites and signs its staff out; this repeats that for anything that slipped in
 * between (a session that opened, an invite sent from a request already running) and for a
 * request whose own sign-out failed. Safe to repeat, does nothing once the offboarding has been
 * cancelled (reactivate), and writes to the trail only when it actually changed something, so a
 * retried job does not fill it.
 *
 * It does not export or delete anything: that is a later step (docs/ARCHITECTURE.md, onboarding).
 */
export async function prepareOffboarding(pool: pg.Pool, job: OffboardJob): Promise<boolean> {
  const stillOffboarding = await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'select status from tenants where id = $1',
      [job.hospitalId],
    );
    return rows[0]?.status === 'offboarding';
  });
  if (!stillOffboarding) return false;

  const sessionsEnded = await endHospitalSessions(pool, job.hospitalId);
  await withPlatformTransaction(pool, async (client) => {
    const invitesWithdrawn = await withdrawOpenInvites(client, job.hospitalId);
    if (sessionsEnded === 0 && invitesWithdrawn === 0) return;
    await recordPlatformAudit(client, {
      actorId: job.requestedBy,
      action: 'hospital.offboard_swept',
      entity: 'hospital',
      entityId: job.hospitalId,
      hospitalId: job.hospitalId,
      detail: { invitesWithdrawn, sessionsEnded },
    });
  });
  return true;
}
