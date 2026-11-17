import type pg from 'pg';
import { signOffboardExport } from '../../core/files/signing.js';
import type { Notifier } from '../../core/notifier/notifier.js';
import { withPlatformTransaction } from '../../core/platform/db.js';

export const EXPORT_LINK_JOB = 'platform.export-link-email';

/** How long a download link lasts (decided in #959): seven days, then the platform issues another. */
export const EXPORT_LINK_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Ids only. The signed link is a credential, so it is never put in the queue's table (no row-level
 * security there) nor handed to the operator: the job makes it when it runs and the only place it
 * goes is the admin's mailbox.
 */
export interface ExportLinkJob {
  exportId: string;
  adminUserId: string;
}

/** The public path of the download: the web app's origin proxies `/api` to the API. */
export function exportLinkPath(
  secret: string,
  exportId: string,
  adminUserId: string,
  expires: number,
): string {
  const signature = signOffboardExport(secret, `${exportId}.${adminUserId}`, expires);
  return `/api/offboarding-exports/${exportId}?admin=${adminUserId}&expires=${expires}&signature=${signature}`;
}

/**
 * Emails the download link of a made export to the admin it was issued for. Looks everything up
 * again: nothing is sent when the export is not `succeeded`, the hospital is no longer offboarding
 * or the person is no longer an active admin of it (`offboarding_admin_contacts` answers that,
 * since the platform role has no grant on users). Returns whether an email went out. A failed send
 * throws, so the queue retries it.
 */
export async function sendExportLink(
  pool: pg.Pool,
  notifier: Notifier,
  secret: string,
  job: ExportLinkJob,
): Promise<boolean> {
  const target = await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<{ name: string; email: string }>(
      `select t.name, c.email
       from tenant_exports e
       join tenants t on t.id = e.hospital_id
       join lateral offboarding_admin_contacts(e.hospital_id) c on c.user_id = $2
       where e.id = $1 and e.status = 'succeeded' and e.file_key is not null`,
      [job.exportId, job.adminUserId],
    );
    return rows[0] ?? null;
  });
  if (!target) return false;
  const expires = Math.floor(Date.now() / 1000) + EXPORT_LINK_TTL_SECONDS;
  await notifier.send({
    to: target.email,
    template: 'export_link',
    data: {
      hospitalName: target.name,
      linkPath: exportLinkPath(secret, job.exportId, job.adminUserId, expires),
      expiresInDays: EXPORT_LINK_TTL_SECONDS / 86_400,
    },
  });
  return true;
}
