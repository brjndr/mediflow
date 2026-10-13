import { randomUUID } from 'node:crypto';
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
import { CodeFileError, parseCodeFile } from './csv.js';
import { checkedCodes, loadCodes } from './load.js';

/**
 * The codes API through the real app and database: reading a code file, loading a set, the
 * search with a hospital's favourites first, marking favourites, the hospital boundary and
 * permissions. The codes are shared by every hospital, so this file owns the table while it runs.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the codes module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Searches codes, cannot choose favourites. */
let doctor: TestUser;
/** No code permissions at all. */
let storeKeeper: TestUser;

const ICD10 = `code,title
A09,"Infectious gastroenteritis and colitis, unspecified"
E10.9,Type 1 diabetes mellitus without complications
E11.2,Type 2 diabetes mellitus with kidney complications
E11.9,Type 2 diabetes mellitus without complications
I10,Essential (primary) hypertension
J06.9,"Acute upper respiratory infection, unspecified"
J18.9,"Pneumonia, unspecified"
N18.9,"Chronic kidney disease, unspecified"
R51,Headache
`;
const PROCEDURES = `code,title
PR-0001,Appendicectomy
PR-0002,Arthroscopy of knee
PR-0003,Caesarean section
`;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
interface Code {
  id: string;
  system: string;
  code: string;
  title: string;
  favourite: boolean;
}
interface Page {
  items: Code[];
  nextCursor: string | null;
  total?: number;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const search = (body: object = {}, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/codes/search',
    headers: headers(options),
    payload: { system: 'icd10', ...body },
  });
const mark = (id: string, options: Options = {}) =>
  app.inject({ method: 'PUT', url: `/codes/${id}/favourite`, headers: headers(options) });
const unmark = (id: string, options: Options = {}) =>
  app.inject({ method: 'DELETE', url: `/codes/${id}/favourite`, headers: headers(options) });

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
const codes = (response: Response) => response.json<Page>().items.map((item) => item.code);

/** The id of a code of the set, as a search gives it. */
async function idOf(code: string, system = 'icd10'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from codes where system = $1 and code = $2',
    [system, code],
  );
  if (!rows[0]) throw new Error(`no code ${code}`);
  return rows[0].id;
}

/** Every page of a search, one after the other. */
async function all(body: object, options: Options = {}): Promise<Code[]> {
  const items: Code[] = [];
  let cursor: string | null | undefined;
  do {
    const page = (await search({ ...body, ...(cursor ? { cursor } : {}) }, options)).json<Page>();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const clearCodes = async () => {
  await pool.query('delete from code_favourites');
  await pool.query('delete from codes');
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  await clearCodes();
  hospital = await createTenant(pool, 'Codes Hospital', { features: { codes: true } });
  clinic = await createTenant(pool, 'Codes Clinic', { features: { codes: true } });
  closed = await createTenant(pool, 'Codes Closed', { features: { codes: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Codes Admin', { withPassword: false });
  doctor = await createUser(pool, 'Codes Doctor', { withPassword: false });
  storeKeeper = await createUser(pool, 'Codes Storekeeper', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
  await loadCodes(pool as unknown as pg.ClientBase, 'icd10', ICD10);
  await loadCodes(pool as unknown as pg.ClientBase, 'procedure', PROCEDURES);
});

afterAll(async () => {
  try {
    await clearCodes();
    await deleteUsers(pool, [admin, doctor, storeKeeper].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('a code file', () => {
  it('is read as a spreadsheet writes it', () => {
    const text = '﻿code,title\r\nA09,"Colitis, unspecified"\r\n\r\nB1,"Said ""so"""\nC2, Spaced \n';
    expect(parseCodeFile(text)).toEqual([
      { line: 2, code: 'A09', title: 'Colitis, unspecified' },
      { line: 4, code: 'B1', title: 'Said "so"' },
      { line: 5, code: 'C2', title: ' Spaced ' },
    ]);
    expect(parseCodeFile('Code , TITLE\nA,"Two\nlines"\nB,x')).toEqual([
      { line: 2, code: 'A', title: 'Two\nlines' },
      { line: 4, code: 'B', title: 'x' },
    ]);
    expect(parseCodeFile('code,title\n')).toEqual([]);
  });

  it('is refused with the line that is wrong, and never a value of it', () => {
    const bad: [RegExp, string][] = [
      [/the file is empty/, ''],
      [/line 1: the first line must be: code,title/, 'A09,Colitis'],
      [/line 1: the first line must be/, 'code,title,notes\nA,b,c'],
      [/line 3: expected a code and a title, found 3/, 'code,title\nA,b\nC,d,e'],
      [/line 2: expected a code and a title, found 1/, 'code,title\nonly'],
      [/line 2: a quoted value is not closed/, 'code,title\nA,"open\nB,c'],
    ];
    for (const [message, text] of bad) {
      expect(() => parseCodeFile(text), text).toThrow(message);
      expect(() => parseCodeFile(text)).toThrow(CodeFileError);
    }
    const checked: [RegExp, string][] = [
      [/line 2: the code is not letters/, 'code,title\nA 09,Colitis'],
      [/line 2: the code is not letters/, `code,title\n${'A'.repeat(21)},Colitis`],
      [/line 3: the title is empty/, 'code,title\nA,b\nC,"  "'],
      [/line 2: the title is empty or longer/, `code,title\nA,${'x'.repeat(301)}`],
      [/line 2: the title has a character that is not text/, 'code,title\nA,"two\nlines"'],
      [/line 4: the code A09 is also on line 2/, 'code,title\nA09,x\nB,y\nA09,z'],
    ];
    for (const [message, text] of checked) expect(() => checkedCodes(text), text).toThrow(message);
    expect(checkedCodes('code,title\n A09 ,"  Colitis,   unspecified "')).toEqual([
      { code: 'A09', title: 'Colitis, unspecified' },
    ]);
  });
});

describe('loading a set', () => {
  const count = async (system: string) =>
    (
      await pool.query<{ n: number }>('select count(*)::int as n from codes where system = $1', [
        system,
      ])
    ).rows[0]?.n;
  const load = (text: string) => loadCodes(pool as unknown as pg.ClientBase, 'procedure', text);

  it('adds what is new, changes the titles that changed, and removes nothing', async () => {
    const appendicectomy = await idOf('PR-0001', 'procedure');
    await mark(appendicectomy);
    const result = await load(
      'code,title\nPR-0001,Appendectomy\nPR-0002,Arthroscopy of knee\nPR-0004,Colonoscopy\n',
    );
    expect(result).toEqual({ read: 3, added: 1, retitled: 1, unchanged: 1 });
    expect(await count('procedure')).toBe(4);
    // The code keeps its identity, so what names it still does: here, a hospital's favourite.
    const found = (await search({ system: 'procedure' })).json<Page>().items;
    expect(found.map((item) => [item.code, item.title, item.favourite])).toEqual([
      ['PR-0001', 'Appendectomy', true],
      ['PR-0002', 'Arthroscopy of knee', false],
      ['PR-0003', 'Caesarean section', false],
      ['PR-0004', 'Colonoscopy', false],
    ]);
    expect(found[0]?.id).toBe(appendicectomy);
    expect(await load('code,title\nPR-0001,Appendectomy\n')).toEqual({
      read: 1,
      added: 0,
      retitled: 0,
      unchanged: 1,
    });
    // The other set is another set.
    expect(await count('icd10')).toBe(9);
    await unmark(appendicectomy);
  });

  it('changes nothing when the file has a mistake anywhere in it', async () => {
    const before = await count('procedure');
    await expect(load('code,title\nPR-0009,New one\nbad code,Another\n')).rejects.toThrow(/line 3/);
    expect(await count('procedure')).toBe(before);
  });

  it('is never something a request can do: the app role reads codes and no more', async () => {
    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));
    expect((await sql('select 1 from codes')).rowCount).toBeGreaterThan(0);
    for (const statement of [
      "insert into codes (system, code, title) values ('icd10', 'X1', 'Planted')",
      "update codes set title = 'Changed'",
      'delete from codes',
    ]) {
      await expect(sql(statement), statement).rejects.toThrow(/permission denied/);
    }
  });
});

describe('the search', () => {
  it('gives a set in the order of its codes, a page at a time, with the total once', async () => {
    const first = await search({ limit: 4 });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(codes(first)).toEqual(['A09', 'E10.9', 'E11.2', 'E11.9']);
    const page = first.json<Page>();
    expect(page.total).toBe(9);
    expect(page.items[0]).toEqual({
      id: page.items[0]?.id,
      system: 'icd10',
      code: 'A09',
      title: 'Infectious gastroenteritis and colitis, unspecified',
      favourite: false,
    });
    const second = await search({ limit: 4, cursor: page.nextCursor });
    expect(codes(second)).toEqual(['I10', 'J06.9', 'J18.9', 'N18.9']);
    expect(second.json<Page>().total).toBeUndefined();
    const third = await search({ limit: 4, cursor: second.json<Page>().nextCursor });
    expect(codes(third)).toEqual(['R51']);
    expect(third.json<Page>().nextCursor).toBeNull();
    expect(codes(await search({ system: 'procedure' }))).toEqual([
      'PR-0001',
      'PR-0002',
      'PR-0003',
      'PR-0004',
    ]);
  });

  it('finds a code from its start, with or without its dot, and a title from the start of a word', async () => {
    const found = async (q: string) => codes(await search({ q }));
    expect(await found('E11')).toEqual(['E11.2', 'E11.9']);
    expect(await found('e119')).toEqual(['E11.9']);
    expect(await found('E11.9')).toEqual(['E11.9']);
    expect(await found('diab')).toEqual(['E10.9', 'E11.2', 'E11.9']);
    expect(await found('KIDNEY')).toEqual(['E11.2', 'N18.9']);
    // The start of a word, not the middle of one, and the start of the code, not its end.
    expect(await found('abetes')).toEqual([]);
    expect(await found('1.9')).toEqual([]);
    // Every word, in any order, each in the code or in the title.
    expect(await found('complications without')).toEqual(['E10.9', 'E11.9']);
    expect(await found('e11 kidney')).toEqual(['E11.2']);
    expect(await found('unspecified j')).toEqual(['J06.9', 'J18.9']);
    expect(await found('   ')).toHaveLength(9);
    expect((await search({ q: 'diab' })).json<Page>().total).toBe(3);
  });

  it('takes what was typed as text, whatever it holds', async () => {
    for (const q of [
      '(primary)',
      '%',
      '_',
      '\\',
      '.*',
      '[a-z]',
      'a|b',
      '^',
      '$',
      'e11%',
      '.',
      '+',
    ]) {
      const response = await search({ q });
      expect(response.statusCode, q).toBe(200);
    }
    expect(codes(await search({ q: '%' }))).toEqual([]);
    expect(codes(await search({ q: '.*' }))).toEqual([]);
    expect(codes(await search({ q: 'primary' }))).toEqual(['I10']);
  });

  it('refuses a search it does not understand', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/codes/search', headers: headers(), payload: {} }))
        .statusCode,
    ).toBe(400);
    expect((await search({ system: 'snomed' })).statusCode).toBe(400);
    expect((await search({ limit: 101 })).statusCode).toBe(400);
    expect((await search({ q: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await search({ favourites: 'yes' })).statusCode).toBe(400);
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      'made-up',
      forged({ p: 'x', c: 'A', i: randomUUID() }),
      forged({ p: 'n', c: 'A', i: 'not-a-uuid' }),
      forged({ p: 'n', c: 'x'.repeat(21), i: randomUUID() }),
      forged(['n', 'A', randomUUID()]),
    ]) {
      expect(errorOf(await search({ cursor })), cursor).toEqual([400, 'invalid_cursor']);
    }
  });
});

describe('favourites', () => {
  it('are the hospital’s own, come first in every search, and are marked once', async () => {
    const [hypertension, pneumonia] = [await idOf('I10'), await idOf('J18.9')];
    const response = await mark(pneumonia);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: pneumonia,
      system: 'icd10',
      code: 'J18.9',
      title: 'Pneumonia, unspecified',
      favourite: true,
    });
    await mark(hypertension);
    await mark(hypertension);

    const found = (await search()).json<Page>().items;
    expect(found.map((item) => [item.code, item.favourite]).slice(0, 4)).toEqual([
      ['I10', true],
      ['J18.9', true],
      ['A09', false],
      ['E10.9', false],
    ]);
    expect(codes(await search({ q: 'unspecified' }))).toEqual(['J18.9', 'A09', 'J06.9', 'N18.9']);
    // The favourites alone: what a search box shows before anything is typed.
    const only = await search({ favourites: true });
    expect(codes(only)).toEqual(['I10', 'J18.9']);
    expect(only.json<Page>().total).toBe(2);
    expect(codes(await search({ favourites: true, q: 'pneu' }))).toEqual(['J18.9']);
    expect(codes(await search({ favourites: true, system: 'procedure' }))).toEqual([]);

    const { rows } = await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and entity = 'code' and entity_id = $2 order by at`,
      [hospital.id, hypertension],
    );
    expect(rows.map((row) => row.action)).toEqual(['favourite']);

    const gone = await unmark(hypertension);
    expect(gone.json()).toMatchObject({ code: 'I10', favourite: false });
    expect((await unmark(hypertension)).statusCode).toBe(200);
    expect(codes(await search({ favourites: true }))).toEqual(['J18.9']);
    const events = await pool.query<{ payload: unknown }>(
      `select payload from outbox where tenant_id = $1 and event = 'master.changed' and entity_id = $2 order by occurred_at, id`,
      [hospital.id, hypertension],
    );
    expect(events.rows.map((row) => row.payload)).toEqual([
      { kind: 'code_favourite', change: 'added' },
      { kind: 'code_favourite', change: 'removed' },
    ]);
    await unmark(pneumonia);
  });

  it('page from the favourites into the other codes without missing or repeating one', async () => {
    const marked = ['E11.9', 'J06.9', 'R51'];
    for (const code of marked) await mark(await idOf(code));
    const expected = ['E11.9', 'J06.9', 'R51', 'A09', 'E10.9', 'E11.2', 'I10', 'J18.9', 'N18.9'];
    // Every page size: the favourites end in the middle of a page, at its end, and on their own.
    for (const limit of [1, 2, 3, 4, 5, 9, 25]) {
      const items = await all({ limit });
      expect(
        items.map((item) => item.code),
        `limit ${limit}`,
      ).toEqual(expected);
      expect(items.filter((item) => item.favourite).map((item) => item.code)).toEqual(marked);
    }
    expect((await all({ limit: 2, favourites: true })).map((item) => item.code)).toEqual(marked);
    expect((await all({ limit: 1, q: 'unspecified' })).map((item) => item.code)).toEqual([
      'J06.9',
      'A09',
      'J18.9',
      'N18.9',
    ]);
    for (const code of marked) await unmark(await idOf(code));
  });

  it('answer 404 for a code that does not exist', async () => {
    for (const id of [randomUUID(), 'not-an-id']) {
      expect(errorOf(await mark(id)), id).toEqual([404, 'code_not_found']);
      expect(errorOf(await unmark(id)), id).toEqual([404, 'code_not_found']);
    }
  });
});

describe('access', () => {
  it('lets someone who may only search see codes and favourites and choose none', async () => {
    const options = { user: doctor };
    expect((await search({}, options)).statusCode).toBe(200);
    const id = await idOf('A09');
    expect(errorOf(await mark(id, options))).toEqual([403, 'permission_denied']);
    expect(errorOf(await unmark(id, options))).toEqual([403, 'permission_denied']);
  });

  it('shows nothing to a role without the permission', async () => {
    expect(errorOf(await search({}, { user: storeKeeper }))).toEqual([403, 'permission_denied']);
  });

  it('does not exist for a hospital with the module off', async () => {
    expect(errorOf(await search({}, { tenant: closed }))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await mark(await idOf('A09'), { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('needs a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/codes/search',
      payload: { system: 'icd10' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('share the codes and keep their favourites to themselves', async () => {
    const [headache, colitis] = [await idOf('R51'), await idOf('A09')];
    await mark(headache);
    await mark(colitis, { tenant: clinic });

    expect(codes(await search({ favourites: true }))).toEqual(['R51']);
    expect(codes(await search({ favourites: true }, { tenant: clinic }))).toEqual(['A09']);
    // The same codes, each hospital's own first.
    expect(codes(await search({ limit: 2 }))).toEqual(['R51', 'A09']);
    expect(codes(await search({ limit: 2 }, { tenant: clinic }))).toEqual(['A09', 'E10.9']);
    const ours = (await search()).json<Page>().items.find((item) => item.code === 'A09');
    expect(ours?.favourite).toBe(false);
    // Taking one's own mark away leaves the other hospital's.
    await unmark(colitis);
    expect(codes(await search({ favourites: true }, { tenant: clinic }))).toEqual(['A09']);

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      marks: (await client.query<{ tenant_id: string }>('select tenant_id from code_favourites'))
        .rows,
      removed: (await client.query('delete from code_favourites where code_id = $1', [colitis]))
        .rowCount,
    }));
    expect(seen).toEqual({ marks: [{ tenant_id: hospital.id }], removed: 0 });
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('insert into code_favourites (tenant_id, code_id) values ($1, $2)', [
          clinic.id,
          headache,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await unmark(headache);
    await unmark(colitis, { tenant: clinic });
  });
});

describe('a set of full size', () => {
  it('is searched a page at a time without reading it whole', async () => {
    // As many codes as the largest edition of ICD-10, with a favourite near each end.
    const lines = ['code,title'];
    for (let n = 0; n < 70_000; n++) {
      const code = `Z${String(Math.floor(n / 100)).padStart(3, '0')}.${String(n % 100).padStart(2, '0')}`;
      lines.push(
        `${code},Sample condition number ${n} of the ${n % 2 === 0 ? 'left' : 'right'} side`,
      );
    }
    await loadCodes(pool as unknown as pg.ClientBase, 'icd10', `${lines.join('\n')}\n`);
    try {
      await mark(await idOf('Z699.99'));
      await mark(await idOf('Z000.00'));
      const timed = async (body: object) => {
        const started = performance.now();
        const response = await search(body);
        return { response, ms: performance.now() - started };
      };
      const first = await timed({ limit: 25 });
      expect(codes(first.response).slice(0, 3)).toEqual(['Z000.00', 'Z699.99', 'A09']);
      expect(first.response.json<Page>().total).toBe(70_009);
      const typed = await timed({ q: 'z6999' });
      expect(codes(typed.response)).toEqual([
        'Z699.99',
        'Z699.90',
        'Z699.91',
        'Z699.92',
        'Z699.93',
        'Z699.94',
        'Z699.95',
        'Z699.96',
        'Z699.97',
        'Z699.98',
      ]);
      // "4999" starts the code of five right-sided conditions and is the number of a sixth.
      const words = await timed({ q: 'right number 4999' });
      expect(codes(words.response)).toEqual([
        'Z049.99',
        'Z499.91',
        'Z499.93',
        'Z499.95',
        'Z499.97',
        'Z499.99',
      ]);
      // A page deep in the set costs what the first one does.
      let cursor = first.response.json<Page>().nextCursor;
      for (let page = 0; page < 3; page++) {
        cursor = (await search({ limit: 100, cursor })).json<Page>().nextCursor;
      }
      const deep = await timed({ limit: 100, cursor });
      expect(deep.response.json<Page>().items).toHaveLength(100);
      // Generous: it is here to catch a search that reads or sorts the whole set, not to time one.
      for (const { ms } of [first, typed, words, deep]) expect(ms).toBeLessThan(2000);
    } finally {
      await pool.query('delete from code_favourites');
      await pool.query("delete from codes where code like 'Z%'");
    }
  }, 120_000);
});
