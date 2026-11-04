import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  grantRoleDefaults,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
import { spread } from './discount.js';

/**
 * Discounts on invoices (#116): a percentage or an amount on a line or on the whole bill, tax on
 * what is left, approval above the hospital's limit by someone other than who gave it, and the
 * hospital boundary.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let admin2: TestUser;
let desk: TestUser;
let doctor: TestUser;
let clinicAdmin: TestUser;
let encounter = '';
let clinicEncounter = '';
let patient = '';

interface Discount {
  kind: 'percent' | 'amount';
  value: number;
  reason: string;
}
interface Line {
  id: string;
  chargeId?: string;
  totalMinor: number;
  taxMinor: number;
  discount?: Discount;
  discountMinor: number;
  billDiscountMinor: number;
}
interface Invoice {
  id: string;
  number?: string;
  status: string;
  lines: Line[];
  totalMinor: number;
  taxMinor: number;
  discountMinor: number;
  billDiscount?: Discount;
  discountStatus: string;
  discountAppliedBy?: string;
  discountApprovedAt?: string;
  version: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}

const send = (
  method: 'POST' | 'PATCH' | 'PUT',
  url: string,
  body: object,
  { tenant = hospital, user = desk }: Options = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': randomUUID() },
    payload: body,
  });
const get = (url: string, { tenant = hospital, user = desk }: Options = {}) =>
  app.inject({ url, headers: as(tenant.id, user.id) });
type Reply = { statusCode: number; body: string; json: <T = { error: { code: string } }>() => T };
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];
async function ok<T>(response: Promise<Reply> | Reply, status = 200): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

let counter = 0;
async function addCharge(price: number, { quantity = 1, taxClass = null as string | null } = {}) {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into charges (tenant_id, encounter_id, patient_id, source, source_ref, description,
       quantity, unit_price_minor, tax_class)
     values ($1, $2, $3, 'service', $4, $5, $6, $7, $8) returning id`,
    [
      hospital.id,
      encounter,
      patient,
      `disc:${counter}:${randomUUID()}`,
      `Item ${counter}`,
      quantity,
      price,
      taxClass,
    ],
  );
  return rows[0]?.id ?? '';
}

const draft = (
  chargeIds: string[],
  extra: object = {},
  options: Options = {},
  manualLines: object[] = [],
) =>
  ok<Invoice>(
    send(
      'POST',
      `/encounters/${encounter}/invoices`,
      { chargeIds, manualLines, ...extra },
      options,
    ),
    201,
  );
const change = (invoice: Invoice, content: object, options: Options = {}) =>
  send('PATCH', `/invoices/${invoice.id}`, { ...content, version: invoice.version }, options);
const setLimit = (limitBp: number) =>
  ok(send('PUT', '/billing/discount-settings', { limitBp }, { user: admin }));

const percent = (value: number, reason = 'goodwill'): Discount => ({
  kind: 'percent',
  value,
  reason,
});
const amount = (value: number, reason = 'goodwill'): Discount => ({
  kind: 'amount',
  value,
  reason,
});

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: new MemoryQueue() });
  pool = app.database.pool;
  const features = { patients: true, clinical: true, services: true, billing: true };
  hospital = await createTenant(pool, 'Discount Hospital', { features });
  clinic = await createTenant(pool, 'Discount Clinic', { features, currency: 'AED' });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Discount Admin');
  admin2 = await user('Discount Second Admin');
  desk = await user('Discount Desk');
  doctor = await user('Discount Doctor');
  clinicAdmin = await user('Discount Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin2, hospital, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const made = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, 'DS-0000001', 'Asha', 'Test', '1980-05-01', 'female', '+91 9800000000', 'test')
     returning id`,
    [hospital.id],
  );
  patient = made.rows[0]?.id ?? '';
  const clinicPatient = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, 'DS-0000002', 'Dina', 'Test', '1980-05-01', 'female', '+91 9800000000', 'test')
     returning id`,
    [clinic.id],
  );
  const opened = (tenant: TestTenant, patientId: string, by: TestUser) =>
    pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by)
       values ($1, $2, 'opd', $3) returning id`,
      [tenant.id, patientId, by.id],
    );
  encounter = (await opened(hospital, patient, admin)).rows[0]?.id ?? '';
  clinicEncounter =
    (await opened(clinic, clinicPatient.rows[0]?.id ?? '', clinicAdmin)).rows[0]?.id ?? '';
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'invoice_lines',
      'charges',
      'invoices',
      'invoice_counters',
      'billing_settings',
      'encounters',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, clinic]);
  await deleteUsers(pool, [admin, admin2, desk, doctor, clinicAdmin]);
  await app.close();
});

describe('spreading a bill discount', () => {
  it('adds up exactly and gives leftover units to the largest remainders', () => {
    expect(spread([1000n, 1000n, 1000n], 100n)).toEqual([34n, 33n, 33n]);
    expect(spread([1n, 2n, 7n], 5n).reduce((a, b) => a + b, 0n)).toBe(5n);
    expect(spread([0n, 0n], 10n)).toEqual([0n, 0n]);
    expect(spread([5n, 5n], 0n)).toEqual([0n, 0n]);
  });
});

describe('a discount on a line', () => {
  it('takes a percentage off before tax, and tax follows what is left', async () => {
    const id = await addCharge(10_000, { taxClass: 'standard' });
    const invoice = await draft([id], {
      chargeDiscounts: [{ chargeId: id, discount: percent(400) }],
    });
    const [line] = invoice.lines;
    expect(line).toMatchObject({ totalMinor: 10_000, discountMinor: 400, billDiscountMinor: 0 });
    expect(line?.discount).toEqual(percent(400));
    // 9,600 left, 12% tax is 1,152.
    expect(line?.taxMinor).toBe(1152);
    expect(invoice).toMatchObject({
      discountMinor: 400,
      taxMinor: 1152,
      totalMinor: 9600 + 1152,
      discountStatus: 'none',
    });
  });

  it('takes a fixed amount off a typed line and rounds a percentage half up', async () => {
    const id = await addCharge(333);
    const invoice = await draft(
      [id],
      { chargeDiscounts: [{ chargeId: id, discount: percent(5000) }] },
      { user: admin },
      [
        {
          description: 'Dressing',
          quantity: 2,
          unitPriceMinor: 1000,
          discount: amount(150, 'staff'),
        },
      ],
    );
    // 50% of 333 is 166.5: half up, 167.
    expect(invoice.lines[0]?.discountMinor).toBe(167);
    expect(invoice.lines[1]).toMatchObject({ totalMinor: 2000, discountMinor: 150 });
    expect(invoice.discountMinor).toBe(317);
    expect(invoice.totalMinor).toBe(333 - 167 + 2000 - 150);
  });

  it('refuses a discount above what it comes off, or one for a charge not on the bill', async () => {
    const id = await addCharge(1000);
    const stray = await addCharge(1000);
    expect(
      errorOf(
        await send('POST', `/encounters/${encounter}/invoices`, {
          chargeIds: [id],
          manualLines: [],
          chargeDiscounts: [{ chargeId: id, discount: amount(1001) }],
        }),
      ),
    ).toEqual([422, 'discount_exceeds']);
    expect(
      errorOf(
        await send('POST', `/encounters/${encounter}/invoices`, {
          chargeIds: [id],
          manualLines: [],
          chargeDiscounts: [{ chargeId: stray, discount: amount(10) }],
        }),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      (
        await send('POST', `/encounters/${encounter}/invoices`, {
          chargeIds: [id],
          manualLines: [],
          chargeDiscounts: [
            { chargeId: id, discount: { kind: 'percent', value: 10001, reason: 'staff' } },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send('POST', `/encounters/${encounter}/invoices`, {
          chargeIds: [id],
          manualLines: [],
          chargeDiscounts: [
            { chargeId: id, discount: { kind: 'amount', value: 5, reason: 'because' } },
          ],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('a discount on the whole bill', () => {
  it('is spread over the lines so the shares add up, and tax follows', async () => {
    const ids = [
      await addCharge(1000, { taxClass: 'standard' }),
      await addCharge(1000, { taxClass: 'standard' }),
      await addCharge(1000, { taxClass: 'standard' }),
    ];
    const invoice = await draft(ids, { billDiscount: amount(100, 'charity') });
    expect(invoice.lines.map((line) => line.billDiscountMinor)).toEqual([34, 33, 33]);
    expect(invoice.billDiscount).toEqual(amount(100, 'charity'));
    expect(invoice.discountMinor).toBe(100);
    // 966, 967 and 967 left at 12%: 116 + 116 + 116.
    expect(invoice.lines.map((line) => line.taxMinor)).toEqual([116, 116, 116]);
    expect(invoice.totalMinor).toBe(2900 + 348);
  });

  it('is a share of what the lines cost after their own discounts', async () => {
    const a = await addCharge(10_000);
    const b = await addCharge(10_000);
    const invoice = await draft([a, b], {
      chargeDiscounts: [{ chargeId: a, discount: percent(5000) }],
      billDiscount: percent(1000),
    });
    // Lines cost 5,000 and 10,000 after the first; 10% of 15,000 is 1,500, spread 500 and 1,000.
    expect(invoice.lines.map((line) => line.billDiscountMinor)).toEqual([500, 1000]);
    expect(invoice.discountMinor).toBe(5000 + 1500);
    expect(invoice.totalMinor).toBe(20_000 - 6500);
  });

  it('is refused above the bill, and a bill of nothing takes none', async () => {
    const id = await addCharge(1000);
    expect(
      errorOf(
        await send('POST', `/encounters/${encounter}/invoices`, {
          chargeIds: [id],
          manualLines: [],
          billDiscount: amount(1001),
        }),
      ),
    ).toEqual([422, 'discount_exceeds']);
  });
});

describe('approval above the limit', () => {
  it('holds a discount above the limit until someone else approves it', async () => {
    const id = await addCharge(10_000);
    const invoice = await draft([id], {
      chargeDiscounts: [{ chargeId: id, discount: percent(1000) }],
    });
    expect(invoice.discountStatus).toBe('pending');
    expect(invoice.discountAppliedBy).toBe(desk.id);
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${invoice.id}/issue`,
          { version: invoice.version },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'discount_needs_approval']);
    // Not the person who gave it, and not someone without the permission.
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${invoice.id}/discount-approval`,
          { version: invoice.version },
          { user: desk },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    const own = await draft([await addCharge(10_000)], {}, { user: admin });
    expect(own.discountStatus).toBe('none');
    const byAdmin = await draft(
      [await addCharge(10_000)],
      { billDiscount: percent(2000) },
      { user: admin },
    );
    expect(byAdmin.discountStatus).toBe('pending');
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${byAdmin.id}/discount-approval`,
          { version: byAdmin.version },
          { user: admin },
        ),
      ),
    ).toEqual([403, 'own_discount']);
    const approved = await ok<Invoice>(
      send(
        'POST',
        `/invoices/${invoice.id}/discount-approval`,
        { version: invoice.version },
        { user: admin },
      ),
    );
    expect(approved.discountStatus).toBe('approved');
    expect(approved.discountApprovedAt).toBeDefined();
    const issued = await ok<Invoice>(
      send('POST', `/invoices/${invoice.id}/issue`, { version: approved.version }, { user: desk }),
    );
    expect(issued).toMatchObject({
      status: 'issued',
      discountStatus: 'approved',
      discountMinor: 1000,
    });
    expect(issued.number).toBeDefined();
  });

  it('asks again when the approved amount changes, and not when it does not', async () => {
    const id = await addCharge(10_000);
    const content = {
      chargeIds: [id],
      manualLines: [],
      chargeDiscounts: [{ chargeId: id, discount: percent(1000) }],
    };
    const first = await draft([id], { chargeDiscounts: content.chargeDiscounts });
    const approved = await ok<Invoice>(
      send(
        'POST',
        `/invoices/${first.id}/discount-approval`,
        { version: first.version },
        { user: admin },
      ),
    );
    // Saved again as it is: still approved.
    const same = await ok<Invoice>(change(approved, content, { user: desk }));
    expect(same.discountStatus).toBe('approved');
    // A bigger discount: pending again, and by whoever changed it.
    const bigger = await ok<Invoice>(
      change(
        same,
        { ...content, chargeDiscounts: [{ chargeId: id, discount: percent(1500) }] },
        { user: desk },
      ),
    );
    expect(bigger).toMatchObject({ discountStatus: 'pending', discountAppliedBy: desk.id });
    // Down to within the limit: no approval needed.
    const small = await ok<Invoice>(
      change(
        bigger,
        { ...content, chargeDiscounts: [{ chargeId: id, discount: percent(300) }] },
        { user: desk },
      ),
    );
    expect(small.discountStatus).toBe('none');
    expect(small.discountAppliedBy).toBeUndefined();
  });

  it('keeps who gave a pending discount when someone else saves the draft unchanged', async () => {
    const id = await addCharge(10_000);
    const content = {
      chargeIds: [id],
      manualLines: [],
      chargeDiscounts: [{ chargeId: id, discount: percent(1000) }],
    };
    const first = await draft([id], { chargeDiscounts: content.chargeDiscounts });
    const resaved = await ok<Invoice>(change(first, content, { user: admin }));
    expect(resaved).toMatchObject({ discountStatus: 'pending', discountAppliedBy: desk.id });
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${first.id}/discount-approval`,
          { version: first.version },
          { user: admin2 },
        ),
      ),
    ).toEqual([409, 'version_conflict']);
    const approved = await send(
      'POST',
      `/invoices/${first.id}/discount-approval`,
      { version: resaved.version },
      { user: admin2 },
    );
    expect(approved.statusCode).toBe(200);
  });

  it('refuses an approval with nothing pending, or on an invoice already issued', async () => {
    const plain = await draft([await addCharge(1000)]);
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${plain.id}/discount-approval`,
          { version: plain.version },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'discount_not_pending']);
    const issued = await ok<Invoice>(
      send('POST', `/invoices/${plain.id}/issue`, { version: plain.version }, { user: desk }),
    );
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${plain.id}/discount-approval`,
          { version: issued.version },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'invoice_not_draft']);
  });

  it('cannot leave draft while pending, even by SQL', async () => {
    const id = await addCharge(10_000);
    const pending = await draft([id], {
      chargeDiscounts: [{ chargeId: id, discount: percent(2000) }],
    });
    await expect(
      pool.query(
        `update invoices set status = 'issued', number = $2, fiscal_year = '2026-27',
           issued_at = now(), issued_by = $3 where id = $1`,
        [pending.id, `X-${randomUUID()}`, desk.id],
      ),
    ).rejects.toThrow(/approved before the invoice is issued/);
  });
});

/** Takes the front desk's right to give discounts away while `run` goes, then gives it back. */
async function withoutApply(run: () => Promise<void>) {
  await pool.query(
    `delete from role_permissions
     where tenant_id = $1 and role_id = 'receptionist' and permission = 'discount:apply'`,
    [hospital.id],
  );
  try {
    await run();
  } finally {
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission)
       values ($1, 'receptionist', 'discount:apply')`,
      [hospital.id],
    );
  }
}

describe('the maker and the approval', () => {
  it('reads a discount the same whatever the order of its keys, and a discount that leaves is a change', async () => {
    const id = await addCharge(10_000);
    const second = await addCharge(10_000);
    const first = await draft([id], {
      chargeDiscounts: [{ chargeId: id, discount: percent(1000) }],
    });
    await withoutApply(async () => {
      const reordered = await send(
        'PATCH',
        `/invoices/${first.id}`,
        {
          version: first.version,
          manualLines: [],
          chargeIds: [id],
          chargeDiscounts: [
            { discount: { reason: 'goodwill', value: 1000, kind: 'percent' }, chargeId: id },
          ],
        },
        { user: desk },
      );
      expect(reordered.statusCode).toBe(200);
      // Taking the discounted charge off the bill takes its discount with it: a change.
      const dropped = await send(
        'PATCH',
        `/invoices/${first.id}`,
        { version: first.version + 1, manualLines: [], chargeIds: [second] },
        { user: desk },
      );
      expect(errorOf(dropped)).toEqual([403, 'permission_denied']);
    });
  });

  it('asks again when the composition changes even at the same discount total', async () => {
    const a = await addCharge(10_000);
    const b = await addCharge(10_000);
    const first = await draft([a, b], { billDiscount: amount(2000) });
    const approved = await ok<Invoice>(
      send(
        'POST',
        `/invoices/${first.id}/discount-approval`,
        { version: first.version },
        { user: admin },
      ),
    );
    expect(approved.discountStatus).toBe('approved');
    // The same 20.00 off, now on one line instead of the bill.
    const moved = await ok<Invoice>(
      change(
        approved,
        {
          chargeIds: [a, b],
          manualLines: [],
          chargeDiscounts: [{ chargeId: a, discount: amount(2000) }],
        },
        { user: desk },
      ),
    );
    expect(moved.discountStatus).toBe('pending');
  });

  it('asks again when the bill changes but the discount total does not', async () => {
    const a = await addCharge(10_000);
    const b = await addCharge(10_000);
    const first = await draft([a, b], { billDiscount: amount(1500) });
    const approved = await ok<Invoice>(
      send(
        'POST',
        `/invoices/${first.id}/discount-approval`,
        { version: first.version },
        { user: admin },
      ),
    );
    // A smaller bill with the very same 15.00 off is a larger share of it.
    const smaller = await ok<Invoice>(
      change(
        approved,
        { chargeIds: [a], manualLines: [], billDiscount: amount(1500) },
        { user: desk },
      ),
    );
    expect(smaller.discountStatus).toBe('pending');
  });

  it('keeps who gave a discount within the limit, so a lower limit cannot make them its approver', async () => {
    await setLimit(2000);
    try {
      const id = await addCharge(10_000);
      const within = await draft([id], { billDiscount: percent(1500) }, { user: admin });
      expect(within.discountStatus).toBe('none');
      await setLimit(500);
      const resaved = await ok<Invoice>(
        change(
          within,
          { chargeIds: [id], manualLines: [], billDiscount: percent(1500) },
          { user: admin2 },
        ),
      );
      expect(resaved).toMatchObject({ discountStatus: 'pending', discountAppliedBy: admin.id });
      expect(
        errorOf(
          await send(
            'POST',
            `/invoices/${within.id}/discount-approval`,
            { version: resaved.version },
            { user: admin },
          ),
        ),
      ).toEqual([403, 'own_discount']);
    } finally {
      await setLimit(500);
    }
  });

  it('cannot change what an issued invoice recorded about its discount, even by SQL', async () => {
    const id = await addCharge(10_000);
    const invoice = await draft([id], { billDiscount: percent(200, 'staff') });
    const issued = await ok<Invoice>(
      send('POST', `/invoices/${invoice.id}/issue`, { version: invoice.version }, { user: desk }),
    );
    expect(issued.status).toBe('issued');
    await expect(
      pool.query(`update invoices set bill_discount_reason = 'other' where id = $1`, [issued.id]),
    ).rejects.toThrow(/never changed/);
    await expect(
      pool.query(`update invoices set discount_applied_by = null where id = $1`, [issued.id]),
    ).rejects.toThrow(/never changed/);
  });
});

describe('who may give a discount', () => {
  it('needs discount:apply, and a doctor cannot make or change a bill at all', async () => {
    const id = await addCharge(1000);
    const plain = await draft([id]);
    expect(
      (
        await send(
          'PATCH',
          `/invoices/${plain.id}`,
          { chargeIds: [id], manualLines: [], version: plain.version },
          { user: doctor },
        )
      ).statusCode,
    ).toBe(403);
    // Drop the permission from the front desk: saving the same discounts is fine, changing is not.
    await pool.query(
      `delete from role_permissions where tenant_id = $1 and role_id = 'receptionist' and permission = 'discount:apply'`,
      [hospital.id],
    );
    try {
      const refused = await send(
        'PATCH',
        `/invoices/${plain.id}`,
        {
          chargeIds: [id],
          manualLines: [],
          chargeDiscounts: [{ chargeId: id, discount: percent(100) }],
          version: plain.version,
        },
        { user: desk },
      );
      expect(errorOf(refused)).toEqual([403, 'permission_denied']);
      const unchanged = await send(
        'PATCH',
        `/invoices/${plain.id}`,
        { chargeIds: [id], manualLines: [], version: plain.version },
        { user: desk },
      );
      expect(unchanged.statusCode).toBe(200);
    } finally {
      await pool.query(
        `insert into role_permissions (tenant_id, role_id, permission) values ($1, 'receptionist', 'discount:apply')`,
        [hospital.id],
      );
    }
  });
});

describe('the limit', () => {
  it('is 5% until the hospital sets another, and only the admin sets it', async () => {
    expect(await ok<{ limitBp: number }>(get('/billing/discount-settings'))).toEqual({
      limitBp: 500,
    });
    expect(
      errorOf(await send('PUT', '/billing/discount-settings', { limitBp: 1000 }, { user: desk })),
    ).toEqual([403, 'permission_denied']);
    expect(
      (await send('PUT', '/billing/discount-settings', { limitBp: 10_001 }, { user: admin }))
        .statusCode,
    ).toBe(400);
  });

  it('moves what needs approval, for this hospital only', async () => {
    await setLimit(2000);
    try {
      expect(
        await ok<{ limitBp: number }>(get('/billing/discount-settings', { user: admin })),
      ).toEqual({
        limitBp: 2000,
      });
      expect(
        await ok<{ limitBp: number }>(
          get('/billing/discount-settings', { tenant: clinic, user: clinicAdmin }),
        ),
      ).toEqual({ limitBp: 500 });
      const id = await addCharge(10_000);
      const within = await draft([id], {
        chargeDiscounts: [{ chargeId: id, discount: percent(1500) }],
      });
      expect(within.discountStatus).toBe('none');
      const over = await draft([await addCharge(10_000)], { billDiscount: percent(2500) });
      expect(over.discountStatus).toBe('pending');
    } finally {
      await setLimit(500);
    }
  });

  it('can be nothing, so every discount waits', async () => {
    await setLimit(0);
    try {
      const id = await addCharge(10_000);
      const invoice = await draft([id], { billDiscount: amount(1) });
      expect(invoice.discountStatus).toBe('pending');
    } finally {
      await setLimit(500);
    }
  });
});

describe('the hospital boundary', () => {
  it('shows another hospital neither the invoice nor its approval', async () => {
    const id = await addCharge(10_000);
    const invoice = await draft([id], { billDiscount: percent(2000) });
    expect(
      errorOf(
        await send(
          'POST',
          `/invoices/${invoice.id}/discount-approval`,
          { version: invoice.version },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'invoice_not_found']);
    const { rows } = await pool.query('select 1 from billing_settings where tenant_id = $1', [
      clinic.id,
    ]);
    expect(rows).toEqual([]);
    expect(clinicEncounter).not.toBe('');
  });
});
