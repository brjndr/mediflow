import type pg from 'pg';
import { withPlatformTransaction } from '../../core/platform/db.js';
import type { Notifier } from '../../core/notifier/notifier.js';

export interface ReminderLog {
  warn(fields: Record<string, string>, message: string): void;
}

export const DELETION_REMINDER_JOB = 'platform.deletion-reminders';

/** Days before `delete_after` at which the hospital's admins are written to. */
export const REMINDER_DAYS = [30, 7] as const;

/**
 * Which reminder a hospital is due, by the whole days left (rounded up). A hospital offboarded
 * with fewer than 30 days left skips the first, so nobody is told "30 days" with five left.
 * Nothing is due once the date has passed: the deletion itself is by request and approval.
 */
export function reminderDue(daysLeft: number): 30 | 7 | null {
  if (daysLeft <= 0) return null;
  if (daysLeft <= 7) return 7;
  if (daysLeft <= 30) return 30;
  return null;
}

interface Candidate {
  id: string;
  name: string;
  delete_after: Date;
  delete_on: string;
  days_left: number;
}

/**
 * Sends the 30 and 7 day reminders to the active managers (`offboarding_admin_contacts`) of every
 * offboarding hospital that is due one. Idempotent: `deletion_reminders` holds a row for each person, date and reminder, written
 * once the mail server took the email, so a repeated run sends nothing again and a run that stopped
 * half way sends only to those not yet written to (a crash between the send and the row can repeat
 * one email, never skip one). A failed send is thrown after the others were tried, and the queue
 * runs the job again. Returns how many emails went out. Nothing is logged but ids and counts.
 */
export async function sendDeletionReminders(
  pool: pg.Pool,
  notifier: Notifier,
  log?: ReminderLog,
): Promise<number> {
  const hospitals = await withPlatformTransaction(pool, async (client) => {
    const { rows } = await client.query<Candidate>(
      `select id, name, delete_after,
              to_char(delete_after at time zone timezone, 'YYYY-MM-DD') as delete_on,
              ceil(extract(epoch from delete_after - now()) / 86400)::int as days_left
       from tenants
       where status = 'offboarding' and delete_after > now()
         and delete_after <= now() + interval '30 days'`,
    );
    return rows;
  });

  let sent = 0;
  let failed = 0;
  for (const hospital of hospitals) {
    const days = reminderDue(hospital.days_left);
    if (!days) continue;
    const admins = await withPlatformTransaction(pool, async (client) => {
      const { rows } = await client.query<{ user_id: string; email: string }>(
        `select c.user_id, c.email from offboarding_admin_contacts($1) c
         where not exists (
           select 1 from deletion_reminders r
           where r.hospital_id = $1 and r.user_id = c.user_id and r.days_before = $2
             and r.delete_after = $3)`,
        [hospital.id, days, hospital.delete_after],
      );
      return rows;
    });
    for (const admin of admins) {
      try {
        await notifier.send({
          to: admin.email,
          template: 'deletion_reminder',
          data: {
            hospitalName: hospital.name,
            daysLeft: hospital.days_left,
            deleteOn: hospital.delete_on,
          },
        });
        await withPlatformTransaction(pool, (client) =>
          client.query(
            `insert into deletion_reminders (hospital_id, user_id, days_before, delete_after)
             values ($1, $2, $3, $4) on conflict do nothing`,
            [hospital.id, admin.user_id, days, hospital.delete_after],
          ),
        );
        sent += 1;
      } catch {
        failed += 1;
        // Ids only: the error's text can quote the address.
        log?.warn(
          { event: 'deletion_reminder_failed', hospitalId: hospital.id, userId: admin.user_id },
          'deletion reminder not sent',
        );
      }
    }
  }
  if (failed > 0) throw new Error('deletion_reminder_failed');
  return sent;
}
