import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
  asTenantSql,
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

/**
 * Transfusion reactions and the donor-to-recipient trace (#585, part B): recording, the hold on a
 * unit's siblings, updates that only raise the severity, the trace both ways, the follow-up from
 * part A (a reactive screening takes the donor's unscreened units out of use), permissions, the
 * hospital boundary and row-level security for each new table.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let nurse: TestUser;
let labTech: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let patientId: string;
let otherPatientId: string;
let encounterId: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Unit {
  id: string;
  status: string;
  version: number;
  patientId?: string;
}
interface Reaction {
  id: string;
  unitId: string;
  patientId: string;
  severity: string;
  currentSeverity: string;
  updates: { note: string; severity?: string }[];
  heldUnitIds?: string[];
}
interface Donor {
  id: string;
}
interface Collection {
  id: string;
  unitIds: string[];
}

const hour = 3_600_000;
const day = 24 * hour;
const headers = ({ tenant = hospital, user = labTech, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `br-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}
const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);
const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows;

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'transfusion_reaction_updates',
  'transfusion_reactions',
  'blood_crossmatches',
  'blood_screenings',
  'patient_blood_groups',
  'blood_unit_events',
  'blood_units',
  'blood_collections',
  'blood_donors',
];
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of TABLES) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('delete from outbox where tenant_id = any($1)', [tenants()]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { bloodbank: true, patients: true };
  hospital = await createTenant(pool, 'Reaction Hospital', { features: on });
  clinic = await createTenant(pool, 'Reaction Clinic', { features: on });
  closed = await createTenant(pool, 'Reaction Closed', { features: { bloodbank: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Reaction Admin', { withPassword: false });
  doctor = await createUser(pool, 'Reaction Doctor', { withPassword: false });
  nurse = await createUser(pool, 'Reaction Nurse', { withPassword: false });
  labTech = await createUser(pool, 'Reaction Lab', { withPassword: false });
  pharmacist = await createUser(pool, 'Reaction Pharmacist', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Reaction Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, labTech, hospital, 'lab_technician');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const patient = async (tenant: TestTenant, mrn: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
         values ($1, $2, 'Reaction', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
        [tenant.id, mrn],
      )
    ).rows[0]!.id;
  patientId = await patient(hospital, 'BR-0000001');
  otherPatientId = await patient(hospital, 'BR-0000002');
  encounterId = (
    await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by)
       values ($1, $2, 'ipd', $3) returning id`,
      [hospital.id, patientId, admin.id],
    )
  ).rows[0]!.id;
}, 60_000);

afterAll(async () => {
  try {
    await wipe();
    await pool.query('delete from encounters where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(
      pool,
      [admin, doctor, nurse, labTech, pharmacist, clinicAdmin].filter(Boolean),
    );
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

// --- helpers -----------------------------------------------------------------------------------

let unitNo = 0;
const negative = {
  hiv: 'negative',
  hbv: 'negative',
  hcv: 'negative',
  syphilis: 'negative',
  malaria: 'negative',
};
const unitOf = async (id: string) =>
  (await ok<{ unit: Unit }>(await get(`/blood-units/${id}`))).unit;
const move = (unit: Unit, to: string, more: object = {}, options: Options = {}) =>
  post(`/blood-units/${unit.id}/move`, { to, version: unit.version, ...more }, options);

const unitSpec = () => ({
  unitNumber: `RU-${String(++unitNo).padStart(5, '0')}`,
  component: 'red_cells',
  volumeMl: 300,
  expiresAt: new Date(Date.now() + 30 * day).toISOString(),
});

/** A donor and one collection of `count` units, left as collected. */
async function donation(count: number) {
  const donor = await ok<Donor>(
    await post('/blood/donors', {
      fullName: 'Asha Verma',
      dateOfBirth: new Date(Date.now() - 30 * 365.25 * day).toISOString().slice(0, 10),
      sex: 'female',
      bloodGroup: 'O+',
    }),
    201,
  );
  const collection = await ok<Collection>(
    await post('/blood/collections', {
      donorId: donor.id,
      volumeMl: 450,
      units: Array.from({ length: count }, unitSpec),
    }),
    201,
  );
  return { donor, collection };
}
/** Takes a collected unit through testing and screening to available. */
async function clear(id: string): Promise<Unit> {
  await ok(await move(await unitOf(id), 'testing'));
  await ok(await post(`/blood-units/${id}/screening`, negative), 201);
  return ok<Unit>(await move(await unitOf(id), 'available'));
}
/** Reserves, issues and (when asked) transfuses an available unit for `patient`. */
async function give(unit: Unit, patient: string, transfuse = true): Promise<Unit> {
  await ok(
    await post(`/blood-units/${unit.id}/crossmatch`, { patientId: patient, result: 'compatible' }),
    201,
  );
  let next = await ok<Unit>(await move(unit, 'reserved', { patientId: patient }, { user: nurse }));
  next = await ok<Unit>(await move(next, 'issued', {}, { user: nurse }));
  return transfuse ? ok<Unit>(await move(next, 'transfused', {}, { user: nurse })) : next;
}
const reactionBody = (unit: Unit, more: object = {}) => ({
  unitId: unit.id,
  patientId,
  transfusedAt: new Date(Date.now() - 2 * hour).toISOString(),
  onsetAt: new Date(Date.now() - hour).toISOString(),
  kind: 'febrile',
  severity: 'mild',
  actions: 'Stopped the transfusion, gave paracetamol, monitored',
  ...more,
});
const react = (unit: Unit, more: object = {}, options: Options = {}) =>
  post('/transfusion-reactions', reactionBody(unit, more), { user: nurse, ...options });

/** A donation of three units: the first given to the patient, the second issued, the third in stock. */
async function setup() {
  await wipe();
  await ok(await post(`/patients/${patientId}/blood-group`, { bloodGroup: 'O+' }));
  const { donor, collection } = await donation(3);
  const [a, b, c] = await Promise.all(collection.unitIds.map(clear));
  void b;
  return { donor, collection, a: a as Unit, b: await unitOf(collection.unitIds[1]!), c: c as Unit };
}

// --- recording ---------------------------------------------------------------------------------

describe('recording a reaction', () => {
  it('is kept for a given unit, audited, announced with ids and severity only', async () => {
    const { a, b, c } = await setup();
    const given = await give(a, patientId);
    const reaction = await ok<Reaction>(
      await react(given, { encounterId, kind: 'allergic', severity: 'moderate' }),
      201,
    );
    expect(reaction).toMatchObject({
      unitId: a.id,
      patientId,
      severity: 'moderate',
      currentSeverity: 'moderate',
      updates: [],
      heldUnitIds: [],
    });
    expect(await audited('transfusion_reaction', reaction.id)).toEqual(['create']);
    const events = await eventsOf(reaction.id);
    expect(events.map((event) => event.event)).toEqual(['blood.reaction_recorded']);
    expect(events[0]?.payload).toEqual({
      unitId: a.id,
      patientId,
      severity: 'moderate',
    });
    // A moderate allergic reaction holds nothing.
    expect((await unitOf(b.id)).status).toBe('available');
    expect((await unitOf(c.id)).status).toBe('available');
    // An issued unit takes one too.
    const issued = await give(b, patientId, false);
    await ok(await react(issued), 201);
    // The list and the reaction itself.
    const list = await ok<{ items: Reaction[] }>(
      await get(`/transfusion-reactions?unitId=${a.id}`, { user: doctor }),
    );
    expect(list.items.map((item) => item.id)).toEqual([reaction.id]);
    const one = await ok<Reaction>(await get(`/transfusion-reactions/${reaction.id}`));
    expect(one.id).toBe(reaction.id);
    expect(await audited('transfusion_reaction', reaction.id)).toEqual(['create', 'read', 'read']);
    const page = await ok<{ items: Reaction[]; nextCursor: string | null }>(
      await get('/transfusion-reactions?limit=1'),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await ok<{ items: Reaction[] }>(
      await get(`/transfusion-reactions?limit=1&cursor=${page.nextCursor}`),
    );
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect(
      (await ok<{ items: Reaction[] }>(await get('/transfusion-reactions?severity=moderate')))
        .items,
    ).toHaveLength(1);
  });

  it('holds the siblings of a severe or hemolytic reaction, and only those still usable', async () => {
    const { a, b, c, collection } = await setup();
    const issued = await give(b, patientId, false);
    const given = await give(a, patientId);
    const reaction = await ok<Reaction>(await react(given, { severity: 'severe' }), 201);
    expect(reaction.heldUnitIds?.sort()).toEqual([issued.id, c.id].sort());
    expect((await unitOf(c.id)).status).toBe('discarded');
    expect((await unitOf(issued.id)).status).toBe('discarded');
    expect((await unitOf(a.id)).status).toBe('transfused');
    const history = await ok<{ history: { toStatus: string; reason?: string }[] }>(
      await get(`/blood-units/${c.id}`),
    );
    expect(history.history.at(-1)).toMatchObject({
      toStatus: 'discarded',
      reason: 'Held after a transfusion reaction',
    });
    expect((await eventsOf(c.id)).map((event) => event.event)).toContain(
      'blood.unit_status_changed',
    );
    expect(await audited('blood_unit', c.id)).toContain('update');
    // A second severe report finds nothing left to hold.
    const again = await ok<Reaction>(await react(given, { severity: 'severe' }), 201);
    expect(again.heldUnitIds).toEqual([]);
    expect(collection.unitIds).toHaveLength(3);
  });

  it('holds the siblings of a hemolytic reaction of any severity', async () => {
    const { a, c } = await setup();
    const given = await give(a, patientId);
    const reaction = await ok<Reaction>(
      await react(given, { kind: 'hemolytic', severity: 'mild' }),
      201,
    );
    expect(reaction.heldUnitIds).toContain(c.id);
  });

  it('is refused for a unit not given, another patient, a bad visit or bad times', async () => {
    const { a, b } = await setup();
    expect(errorOf(await react(a))).toEqual([409, 'unit_not_given']);
    const given = await give(a, patientId);
    expect(errorOf(await react(given, { patientId: otherPatientId }))).toEqual([
      422,
      'patient_mismatch',
    ]);
    expect(
      errorOf(await react(given, { patientId: '2d6f1f4e-0000-4000-8000-000000000000' })),
    ).toEqual([422, 'unknown_patient']);
    expect(
      errorOf(await react(given, { encounterId: '2d6f1f4e-0000-4000-8000-000000000000' })),
    ).toEqual([422, 'unknown_encounter']);
    expect(
      errorOf(
        await react(given, {
          transfusedAt: new Date(Date.now() - hour).toISOString(),
          onsetAt: new Date(Date.now() - 2 * hour).toISOString(),
        }),
      ),
    ).toEqual([422, 'invalid_period']);
    expect(
      errorOf(await react(given, { transfusedAt: new Date(Date.now() + day).toISOString() })),
    ).toEqual([422, 'invalid_period']);
    expect(
      errorOf(await post('/transfusion-reactions', reactionBody(b, { severity: 'dire' }))),
    ).toEqual([400, 'validation_failed']);
    expect(errorOf(await react(given, { unitId: '2d6f1f4e-0000-4000-8000-000000000000' }))).toEqual(
      [404, 'blood_unit_not_found'],
    );
  });

  it('is for the people who care for the patient, the hospital switch and the hospital boundary', async () => {
    const { a } = await setup();
    const given = await give(a, patientId);
    expect((await react(given, {}, { user: pharmacist })).statusCode).toBe(403);
    expect((await get('/transfusion-reactions', { user: pharmacist })).statusCode).toBe(403);
    const reaction = await ok<Reaction>(await react(given, {}, { user: doctor }), 201);
    expect(errorOf(await get('/transfusion-reactions', { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(
      errorOf(
        await get(`/transfusion-reactions/${reaction.id}`, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'transfusion_reaction_not_found']);
    expect(
      (
        await ok<{ items: unknown[] }>(
          await get('/transfusion-reactions', { tenant: clinic, user: clinicAdmin }),
        )
      ).items,
    ).toEqual([]);
    expect(
      errorOf(await get(`/blood-units/${a.id}/trace`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'blood_unit_not_found']);
    expect(
      errorOf(
        await post(
          `/transfusion-reactions/${reaction.id}/updates`,
          { note: 'x' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'transfusion_reaction_not_found']);
  });
});

// --- updates -----------------------------------------------------------------------------------

describe('updates to a reaction', () => {
  it('are appended, may raise the severity and never lower it', async () => {
    const { a, b, c } = await setup();
    const given = await give(a, patientId);
    const reaction = await ok<Reaction>(await react(given), 201);
    const noted = await ok<Reaction>(
      await post(
        `/transfusion-reactions/${reaction.id}/updates`,
        { note: 'Fever settled' },
        { user: nurse },
      ),
      201,
    );
    expect(noted).toMatchObject({ currentSeverity: 'mild', heldUnitIds: [] });
    expect(noted.updates.map((update) => update.note)).toEqual(['Fever settled']);
    const raised = await ok<Reaction>(
      await post(
        `/transfusion-reactions/${reaction.id}/updates`,
        { note: 'Breathless now', severity: 'moderate' },
        { user: doctor },
      ),
      201,
    );
    expect(raised).toMatchObject({ severity: 'mild', currentSeverity: 'moderate' });
    for (const severity of ['mild', 'moderate']) {
      expect(
        errorOf(
          await post(`/transfusion-reactions/${reaction.id}/updates`, { note: 'x', severity }),
        ),
      ).toEqual([422, 'severity_not_raised']);
    }
    expect((await unitOf(c.id)).status).toBe('available');
    // Raised to severe: the siblings are held.
    const severe = await ok<Reaction>(
      await post(`/transfusion-reactions/${reaction.id}/updates`, {
        note: 'Collapsed',
        severity: 'severe',
      }),
      201,
    );
    expect(severe.currentSeverity).toBe('severe');
    expect(severe.heldUnitIds?.sort()).toEqual([b.id, c.id].sort());
    expect((await unitOf(c.id)).status).toBe('discarded');
    expect((await eventsOf(reaction.id)).map((event) => event.event)).toEqual([
      'blood.reaction_recorded',
      'blood.reaction_recorded',
      'blood.reaction_recorded',
    ]);
    const list = await ok<{ items: Reaction[] }>(await get('/transfusion-reactions'));
    expect(list.items[0]?.updates).toHaveLength(3);
    expect(
      errorOf(
        await post(`/transfusion-reactions/2d6f1f4e-0000-4000-8000-000000000000/updates`, {
          note: 'x',
        }),
      ),
    ).toEqual([404, 'transfusion_reaction_not_found']);
  });

  it('cannot be changed or removed in the database', async () => {
    const { a } = await setup();
    const reaction = await ok<Reaction>(await react(await give(a, patientId)), 201);
    await ok(await post(`/transfusion-reactions/${reaction.id}/updates`, { note: 'Noted' }), 201);
    for (const sql of [
      "update transfusion_reactions set actions = 'changed'",
      'delete from transfusion_reactions',
      "update transfusion_reaction_updates set note = 'changed'",
      'delete from transfusion_reaction_updates',
    ]) {
      await expect(asTenantSql(pool, hospital.id, (client) => client.query(sql))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

// --- trace -------------------------------------------------------------------------------------

describe('the trace from donor to recipient', () => {
  it('follows a unit to its donor and recipient, and a donor to every unit and recipient', async () => {
    const { donor, collection, a, b } = await setup();
    const given = await give(a, patientId);
    const reaction = await ok<Reaction>(await react(given, { severity: 'moderate' }), 201);
    const trace = await ok<{
      unit: Unit;
      donor?: { id: string; donorNumber: string; fullName?: string };
      collectionId?: string;
      screeningOutcome?: string;
      history: { toStatus: string }[];
      crossmatches: { patientId: string }[];
      recipientPatientId?: string;
      reactions: Reaction[];
    }>(await get(`/blood-units/${a.id}/trace`));
    expect(trace.unit.status).toBe('transfused');
    expect(trace.donor).toMatchObject({ id: donor.id, fullName: 'Asha Verma' });
    expect(trace).toMatchObject({
      collectionId: collection.id,
      screeningOutcome: 'cleared',
      recipientPatientId: patientId,
    });
    expect(trace.history.map((entry) => entry.toStatus)).toEqual([
      'collected',
      'testing',
      'available',
      'reserved',
      'issued',
      'transfused',
    ]);
    expect(trace.crossmatches.map((match) => match.patientId)).toEqual([patientId]);
    expect(trace.reactions.map((item) => item.id)).toEqual([reaction.id]);
    expect(JSON.stringify(trace)).not.toMatch(/Reaction Patient/);
    expect(await audited('blood_unit', a.id)).toContain('read');
    // A doctor traces a unit but sees no donor name.
    const asDoctor = await ok<{ donor?: Record<string, unknown> }>(
      await get(`/blood-units/${a.id}/trace`, { user: doctor }),
    );
    expect(asDoctor.donor).toMatchObject({ id: donor.id });
    expect(asDoctor.donor).not.toHaveProperty('fullName');
    // A unit nobody has had has no recipient.
    const idle = await ok<{ recipientPatientId?: string; reactions: unknown[] }>(
      await get(`/blood-units/${b.id}/trace`),
    );
    expect(idle.recipientPatientId).toBeUndefined();
    expect(idle.reactions).toEqual([]);

    const donorTrace = await ok<{
      donor: { id: string; fullName?: string };
      units: {
        unit: Unit;
        collectionId?: string;
        recipientPatientId?: string;
        reactionCount: number;
        worstSeverity?: string;
      }[];
    }>(await get(`/blood/donors/${donor.id}/trace`));
    expect(donorTrace.donor).toMatchObject({ id: donor.id, fullName: 'Asha Verma' });
    expect(donorTrace.units).toHaveLength(3);
    const mine = donorTrace.units.find((entry) => entry.unit.id === a.id);
    expect(mine).toMatchObject({
      recipientPatientId: patientId,
      reactionCount: 1,
      worstSeverity: 'moderate',
      collectionId: collection.id,
    });
    expect(donorTrace.units.find((entry) => entry.unit.id === b.id)).toMatchObject({
      reactionCount: 0,
    });
    expect(await audited('blood_donor', donor.id)).toContain('read');
  });

  it('needs the right permissions and stays inside the hospital', async () => {
    const { donor, a } = await setup();
    expect((await get(`/blood-units/${a.id}/trace`, { user: pharmacist })).statusCode).toBe(403);
    // A doctor may trace a unit but not read a donor.
    expect((await get(`/blood/donors/${donor.id}/trace`, { user: doctor })).statusCode).toBe(403);
    expect(
      errorOf(await get(`/blood/donors/${donor.id}/trace`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'blood_donor_not_found']);
    expect(errorOf(await get('/blood/donors/not-an-id/trace'))).toEqual([
      404,
      'blood_donor_not_found',
    ]);
    expect(errorOf(await get('/blood-units/not-an-id/trace'))).toEqual([
      404,
      'blood_unit_not_found',
    ]);
  });
});

// --- part A follow-up --------------------------------------------------------------------------

describe('a reactive screening', () => {
  it('also takes the donor’s other units that are not yet screened out of use', async () => {
    await wipe();
    const { collection } = await donation(3);
    const [first, second, third] = collection.unitIds as [string, string, string];
    const cleared = await clear(third);
    await ok(await move(await unitOf(first), 'testing'));
    const waiting = await ok<Unit>(await move(await unitOf(second), 'testing'));
    await ok(await post(`/blood-units/${first}/screening`, { ...negative, hiv: 'reactive' }), 201);
    expect((await unitOf(first)).status).toBe('discarded');
    expect((await unitOf(waiting.id)).status).toBe('discarded');
    // Already cleared stock is left to the bank to decide.
    expect((await unitOf(cleared.id)).status).toBe('available');
    const history = await ok<{ history: { reason?: string }[] }>(
      await get(`/blood-units/${waiting.id}`),
    );
    expect(history.history.at(-1)?.reason).toBe('Donor had a reactive screening');
  });
});

// --- row-level security ------------------------------------------------------------------------

describe('row-level security', () => {
  it('shows a hospital none of another’s reactions or their updates', async () => {
    const { a } = await setup();
    const reaction = await ok<Reaction>(await react(await give(a, patientId)), 201);
    await ok(await post(`/transfusion-reactions/${reaction.id}/updates`, { note: 'Noted' }), 201);
    for (const table of ['transfusion_reactions', 'transfusion_reaction_updates']) {
      const own = await asTenantSql(pool, hospital.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      const other = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select 1 from ${table}`),
      );
      const none = await asTenantSql(pool, null, (client) =>
        client.query(`select 1 from ${table}`),
      );
      expect(own.rowCount, table).toBeGreaterThan(0);
      expect(other.rowCount, table).toBe(0);
      expect(none.rowCount, table).toBe(0);
    }
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into transfusion_reaction_updates (tenant_id, reaction_id, note, recorded_by)
           values ($1, $2, 'x', $3)`,
          [hospital.id, reaction.id, clinicAdmin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into transfusion_reactions (tenant_id, blood_unit_id, patient_id, transfused_at,
             onset_at, severity, kind, actions, reported_by)
           values ($1, $2, $3, now(), now(), 'mild', 'febrile', 'x', $4)`,
          [hospital.id, a.id, patientId, clinicAdmin.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
