import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  grantRoleDefaults,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { createMemoryNotifier } from '../../core/notifier/notifier.js';
import { reminderDue, sendDeletionReminders } from './deletion-reminders.js';

/** The 30 and 7 day reminders of a deletion (#998), against the real database. */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let pool: pg.Pool;
let hospital: TestTenant;
let other: TestTenant;
let admin: TestUser;
let admin2: TestUser;
let nurse: TestUser;
let stranger: TestUser;
const users: TestUser[] = [];
const notifier = createMemoryNotifier('http://localhost:5173');

const offboard = (tenant: TestTenant, days: number) =>
  pool.query(
    `update tenants set status = 'offboarding', offboarding_requested_at = now(),
       delete_after = now() + make_interval(days => $2::int) where id = $1`,
    [tenant.id, days],
  );
const clear = () => {
  notifier.sent.length = 0;
};

beforeAll(async () => {
  app = await buildTestApp({ notifier });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Reminder Hospital');
  other = await createTenant(pool, 'Other Reminder Hospital');
  await grantRoleDefaults(app, hospital);
  await grantRoleDefaults(app, other);
  for (const [name, role, tenant] of [
    ['Rem Admin', 'admin', hospital],
    ['Rem Admin Two', 'admin', hospital],
    ['Rem Nurse', 'nurse', hospital],
    ['Rem Stranger', 'admin', other],
  ] as const) {
    const user = await createUser(pool, name);
    users.push(user);
    await addMembership(pool, user, tenant, role);
    if (name === 'Rem Admin') admin = user;
    if (name === 'Rem Admin Two') admin2 = user;
    if (name === 'Rem Nurse') nurse = user;
    if (name === 'Rem Stranger') stranger = user;
  }
});

afterAll(async () => {
  await pool.query('delete from deletion_reminders where hospital_id = any($1::uuid[])', [
    [hospital.id, other.id],
  ]);
  await deleteTenants(pool, [hospital, other]);
  await deleteUsers(pool, users);
  await app.close();
});

describe('reminderDue', () => {
  it('picks the reminder by the days left', () => {
    expect(reminderDue(31)).toBeNull();
    expect(reminderDue(30)).toBe(30);
    expect(reminderDue(8)).toBe(30);
    expect(reminderDue(7)).toBe(7);
    expect(reminderDue(1)).toBe(7);
    expect(reminderDue(0)).toBeNull();
  });
});

describe('the deletion reminders', () => {
  it('sends nothing while the date is more than 30 days away', async () => {
    await offboard(hospital, 60);
    expect(await sendDeletionReminders(pool, notifier)).toBe(0);
    expect(notifier.sent).toEqual([]);
  });

  it('writes the 30 day reminder to each active admin of the hospital only, once', async () => {
    await offboard(hospital, 29);
    await offboard(other, 90);
    expect(await sendDeletionReminders(pool, notifier)).toBe(2);
    expect(notifier.sent.map((mail) => mail.to).sort()).toEqual([admin.email, admin2.email].sort());
    expect(notifier.sent.map((mail) => mail.to)).not.toContain(nurse.email);
    expect(notifier.sent.map((mail) => mail.to)).not.toContain(stranger.email);
    expect(notifier.sent[0]?.subject).toContain('Reminder Hospital');
    expect(notifier.sent[0]?.text).toMatch(/\d{4}-\d{2}-\d{2}/);
    clear();
    expect(await sendDeletionReminders(pool, notifier)).toBe(0);
    expect(notifier.sent).toEqual([]);
  });

  it('sends the 7 day reminder later, again once, and not to a deactivated admin', async () => {
    await pool.query("update tenants set delete_after = now() + interval '6 days' where id = $1", [
      hospital.id,
    ]);
    await pool.query(
      "update memberships set status = 'suspended' where tenant_id = $1 and user_id = $2",
      [hospital.id, admin2.id],
    );
    expect(await sendDeletionReminders(pool, notifier)).toBe(1);
    expect(notifier.sent.map((mail) => mail.to)).toEqual([admin.email]);
    clear();
    expect(await sendDeletionReminders(pool, notifier)).toBe(0);
  });

  it('skips the 30 day reminder for a hospital offboarded with fewer days left', async () => {
    await pool.query('delete from deletion_reminders where hospital_id = $1', [hospital.id]);
    await pool.query("update tenants set delete_after = now() + interval '5 days' where id = $1", [
      hospital.id,
    ]);
    await sendDeletionReminders(pool, notifier);
    const { rows } = await pool.query<{ days_before: number }>(
      'select days_before from deletion_reminders where hospital_id = $1',
      [hospital.id],
    );
    expect(rows.map((row) => row.days_before)).toEqual([7]);
  });

  it('sends nothing once the date has passed or the hospital is reactivated', async () => {
    await pool.query('delete from deletion_reminders where hospital_id = $1', [hospital.id]);
    clear();
    await pool.query("update tenants set delete_after = now() - interval '1 day' where id = $1", [
      hospital.id,
    ]);
    expect(await sendDeletionReminders(pool, notifier)).toBe(0);
    await pool.query(
      `update tenants set status = 'active', offboarding_requested_at = null, delete_after = null
       where id = $1`,
      [hospital.id],
    );
    expect(await sendDeletionReminders(pool, notifier)).toBe(0);
    expect(notifier.sent).toEqual([]);
  });

  it('retries only those not yet written to when a send fails', async () => {
    await offboard(hospital, 20);
    let calls = 0;
    const flaky = {
      ...notifier,
      async send(...args: Parameters<typeof notifier.send>) {
        calls += 1;
        if (calls === 1) throw new Error('smtp down');
        return notifier.send(...args);
      },
    };
    await pool.query(
      "update memberships set status = 'active' where tenant_id = $1 and user_id = $2",
      [hospital.id, admin2.id],
    );
    await expect(sendDeletionReminders(pool, flaky)).rejects.toThrow();
    expect(notifier.sent).toHaveLength(1);
    expect(await sendDeletionReminders(pool, notifier)).toBe(1);
    expect(notifier.sent).toHaveLength(2);
    expect(new Set(notifier.sent.map((mail) => mail.to)).size).toBe(2);
  });

  it('writes to whoever manages the hospital, whatever the role is called', async () => {
    const custom = await createTenant(pool, 'Custom Reminder Hospital');
    try {
      await grantRoleDefaults(app, custom);
      // The admin role no longer manages anything; two custom roles do.
      await pool.query(
        `delete from role_permissions where tenant_id = $1 and role_id = 'admin'
           and permission in ('role:manage', 'staff:manage')`,
        [custom.id],
      );
      const roles = [
        ['access_lead', 'role:manage'],
        ['people_lead', 'staff:manage'],
        ['onlooker', 'staff:read'],
      ] as const;
      const expected: string[] = [];
      for (const [roleId, permission] of roles) {
        await pool.query('insert into roles (tenant_id, id, name) values ($1, $2, $2)', [
          custom.id,
          roleId,
        ]);
        await pool.query(
          'insert into role_permissions (tenant_id, role_id, permission) values ($1, $2, $3)',
          [custom.id, roleId, permission],
        );
      }
      for (const roleId of ['access_lead', 'people_lead', 'onlooker', 'admin']) {
        const user = await createUser(pool, `Rem ${roleId}`);
        users.push(user);
        await addMembership(pool, user, custom, roleId);
        if (roleId.endsWith('_lead')) expected.push(user.email);
      }
      // Further from deletion than the shared hospital, so only this one is newly due.
      await offboard(custom, 20);
      clear();
      await sendDeletionReminders(pool, notifier);
      const mine = new Set(users.map((user) => user.email));
      expect(
        notifier.sent
          .map((mail) => mail.to)
          .filter((to) => mine.has(to))
          .sort(),
      ).toEqual(expected.sort());
    } finally {
      await pool.query('delete from deletion_reminders where hospital_id = $1', [custom.id]);
      await deleteTenants(pool, [custom]);
    }
  });
});
