import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileStore } from '../../core/files/store.js';
import { makeTestFileStore, type TestFileStore } from '../../../test/file-store.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
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
 * Image uploads (#99) through the real app and database: asking for a signed link, the limits,
 * receiving the file, the malware scan that holds it, the download link, the hospital boundary,
 * permissions and audit.
 */

let files: TestFileStore;
let store: FileStore;

const queue = new MemoryQueue();
let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let radiologist: TestUser;
let clinicRadiologist: TestUser;
let doctor: TestUser;
let reader: TestUser;
const ids = {
  patient: '',
  service: '',
  clinicPatient: '',
  clinicService: '',
};

interface Upload {
  image: { id: string; status: string; size: number; fileName: string };
  uploadUrl: string;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
type Reply = { statusCode: number; json: () => { error: { code: string } } };

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, 1)]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
// The harmless industry test string every scanner reports.
const EICAR = Buffer.from(
  '%PDF-1.4\n' + 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' + '\n',
);

const headers = ({ tenant = hospital, user = radiologist }: Options = {}) => as(tenant.id, user.id);
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}, key = randomUUID()) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers(options), 'idempotency-key': key },
    payload: body,
  });
const put = (url: string, data: Buffer, contentType: string) =>
  app.inject({ method: 'PUT', url, headers: { 'content-type': contentType }, payload: data });
const errorOf = (reply: Reply) => [reply.statusCode, reply.json().error.code];

async function placeOrder(tenant: TestTenant) {
  const here = tenant === hospital;
  const asDoctor = { tenant, user: doctor };
  const encounter = (
    await post('/encounters', { patientId: here ? ids.patient : ids.clinicPatient }, asDoctor)
  ).json<{ id: string }>();
  return (
    await post(
      `/encounters/${encounter.id}/orders`,
      {
        type: 'imaging',
        serviceId: here ? ids.service : ids.clinicService,
        priority: 'routine',
      },
      asDoctor,
    )
  ).json<{ id: string }>().id;
}

async function performedOrder(tenant = hospital) {
  const orderId = await placeOrder(tenant);
  const at = new Date((Math.floor(Date.now() / 900_000) + 1) * 900_000).toISOString();
  const owner = { tenant, user: tenant === hospital ? radiologist : clinicRadiologist };
  const study = (
    await post(`/radiology/orders/${orderId}/schedule`, { scheduledAt: at }, owner)
  ).json<{ version: number }>();
  await post(`/radiology/orders/${orderId}/perform`, { version: study.version }, owner);
  return orderId;
}

const request = (orderId: string, body: object, options: Options = {}) =>
  post(`/radiology/orders/${orderId}/images`, body, options);

async function uploaded(orderId: string, data = JPEG, type = 'image/jpeg') {
  const asked = await request(orderId, {
    fileName: 'chest.jpg',
    contentType: type,
    size: data.length,
  });
  expect(asked.statusCode).toBe(201);
  const upload = asked.json<Upload>();
  const sent = await put(upload.uploadUrl, data, type);
  expect(sent.statusCode).toBe(204);
  return upload;
}

const statusOf = async (id: string) =>
  (await pool.query<{ status: string }>('select status from imaging_images where id = $1', [id]))
    .rows[0]?.status;

const actions = async (id: string) =>
  (
    await pool.query<{ action: string }>(
      "select action from audit_log where entity = 'imaging_image' and entity_id = $1 order by at",
      [id],
    )
  ).rows.map((row) => row.action);

beforeAll(async () => {
  files = await makeTestFileStore('imaging');
  store = files.store;
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    fileStore: store,
    jobQueue: queue,
  });
  pool = app.database.pool;
  const features = { clinical: true, patients: true, services: true, radiology: true };
  hospital = await createTenant(pool, 'Imaging Hospital', { features });
  clinic = await createTenant(pool, 'Imaging Clinic', { features });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  radiologist = await user('Imaging Radiologist');
  clinicRadiologist = await user('Imaging Clinic Radiologist');
  doctor = await user('Imaging Doctor');
  reader = await user('Imaging Reader');
  await addMembership(pool, radiologist, hospital, 'radiologist');
  await addMembership(pool, clinicRadiologist, clinic, 'radiologist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'image_reader', 'Image reader')",
    [hospital.id],
  );
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission)
     values ($1, 'image_reader', 'imagingStudy:read')`,
    [hospital.id],
  );
  await addMembership(pool, reader, hospital, 'image_reader');
  for (const tenant of [hospital, clinic]) {
    const dept = await pool.query<{ id: string }>(
      "insert into departments (tenant_id, name) values ($1, 'General') returning id",
      [tenant.id],
    );
    await pool.query(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General', 15)`,
      [tenant.id, doctor.id, dept.rows[0]?.id],
    );
    const patient = await pool.query<{ id: string }>(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
       values ($1, 'IM-0000001', 'Ima', 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
      [tenant.id],
    );
    const service = await pool.query<{ id: string }>(
      `insert into services (tenant_id, code, name, category, tax_class, modality)
       values ($1, 'XR-CHEST', 'Chest', 'imaging', 'exempt', 'xray') returning id`,
      [tenant.id],
    );
    if (tenant === hospital) {
      ids.patient = patient.rows[0]?.id ?? '';
      ids.service = service.rows[0]?.id ?? '';
    } else {
      ids.clinicPatient = patient.rows[0]?.id ?? '';
      ids.clinicService = service.rows[0]?.id ?? '';
    }
  }
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'imaging_images',
      'imaging_studies',
      'orders',
      'encounters',
      'outbox',
      'services',
      'doctors',
      'departments',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [radiologist, clinicRadiologist, doctor, reader]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
  await files.cleanup();
});

describe('asking for an upload', () => {
  it('gives a signed link for a performed study and audits it', async () => {
    const orderId = await performedOrder();
    const asked = await request(orderId, {
      fileName: 'chest.jpg',
      contentType: 'image/jpeg',
      size: 100,
    });
    expect(asked.statusCode).toBe(201);
    const upload = asked.json<Upload>();
    expect(upload.image).toMatchObject({ status: 'pending', fileName: 'chest.jpg', size: 100 });
    expect(upload.uploadUrl).toMatch(/^\/imaging-uploads\/[0-9a-f-]+\?expires=\d+&signature=/);
    expect(await actions(upload.image.id)).toEqual(['create']);
  });

  it('answers the same for the same idempotency key', async () => {
    const orderId = await performedOrder();
    const key = randomUUID();
    const body = { fileName: 'a.png', contentType: 'image/png', size: 10 };
    const first = (await post(`/radiology/orders/${orderId}/images`, body, {}, key)).json<Upload>();
    const again = await post(`/radiology/orders/${orderId}/images`, body, {}, key);
    expect(again.statusCode).toBe(201);
    expect(again.json<Upload>().image.id).toBe(first.image.id);
    const list = await get(`/radiology/orders/${orderId}/images`);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('refuses a file over the limit, of another type, or for an unperformed study', async () => {
    const orderId = await performedOrder();
    const big = { fileName: 'big.jpg', contentType: 'image/jpeg', size: 26 * 1024 * 1024 };
    expect(errorOf(await request(orderId, big))).toEqual([422, 'file_too_large']);
    const exe = { fileName: 'x.exe', contentType: 'application/x-msdownload', size: 10 };
    expect(errorOf(await request(orderId, exe))).toEqual([422, 'file_type_not_allowed']);
    const empty = { fileName: 'z.jpg', contentType: 'image/jpeg', size: 0 };
    expect((await request(orderId, empty)).statusCode).toBe(400);

    const unperformed = await placeOrder(hospital);
    const small = { fileName: 'a.jpg', contentType: 'image/jpeg', size: 10 };
    expect(errorOf(await request(unperformed, small))).toEqual([409, 'invalid_transition']);
  });

  it('needs imagingStudy:perform, and another hospital sees nothing', async () => {
    const orderId = await performedOrder();
    const body = { fileName: 'a.jpg', contentType: 'image/jpeg', size: 10 };
    expect(errorOf(await request(orderId, body, { user: reader }))).toEqual([
      403,
      'permission_denied',
    ]);
    const other = { tenant: clinic, user: clinicRadiologist };
    expect(errorOf(await request(orderId, body, other))).toEqual([404, 'order_not_found']);
  });
});

describe('receiving the file and the scan', () => {
  it('holds a received file until the scan clears it, then serves it by a signed link', async () => {
    const orderId = await performedOrder();
    const upload = await uploaded(orderId);
    expect(await statusOf(upload.image.id)).toBe('scanning');
    const early = await get(`/radiology/images/${upload.image.id}/download-url`);
    expect(errorOf(early)).toEqual([409, 'image_not_ready']);

    await queue.drain();
    expect(await statusOf(upload.image.id)).toBe('clean');
    const link = (await get(`/radiology/images/${upload.image.id}/download-url`)).json<{
      url: string;
    }>();
    const file = await app.inject({ url: link.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(JPEG)).toBe(true);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-disposition'])).toContain('attachment');
    expect(await actions(upload.image.id)).toContain('export');
  });

  it('blocks and deletes an infected file', async () => {
    const orderId = await performedOrder();
    const upload = await uploaded(orderId, EICAR, 'application/pdf');
    await queue.drain();
    expect(await statusOf(upload.image.id)).toBe('infected');
    const row = await pool.query<{ file_key: string; scan_result: string }>(
      'select file_key, scan_result from imaging_images where id = $1',
      [upload.image.id],
    );
    expect(row.rows[0]?.scan_result).toBe('Eicar-Test-Signature');
    expect(await store.get(row.rows[0]?.file_key ?? '')).toBeNull();
    const blocked = await get(`/radiology/images/${upload.image.id}/download-url`);
    expect(errorOf(blocked)).toEqual([409, 'image_blocked']);
  });

  it('refuses a wrong size, a wrong type, a forged link and a second use', async () => {
    const orderId = await performedOrder();
    const asked = (
      await request(orderId, { fileName: 'a.jpg', contentType: 'image/jpeg', size: JPEG.length })
    ).json<Upload>();
    const doubled = Buffer.concat([JPEG, JPEG]);
    expect(errorOf(await put(asked.uploadUrl, doubled, 'image/jpeg'))).toEqual([
      400,
      'size_mismatch',
    ]);
    expect(errorOf(await put(asked.uploadUrl, JPEG, 'image/png'))).toEqual([
      415,
      'file_type_mismatch',
    ]);
    // Right size and header, but the bytes are not a JPEG.
    const fake = Buffer.alloc(JPEG.length, 7);
    expect(errorOf(await put(asked.uploadUrl, fake, 'image/jpeg'))).toEqual([
      415,
      'file_type_mismatch',
    ]);
    const forged = asked.uploadUrl.replace(/signature=.{4}/, 'signature=AAAA');
    expect(errorOf(await put(forged, JPEG, 'image/jpeg'))).toEqual([404, 'image_file_not_found']);
    expect((await put(asked.uploadUrl, JPEG, 'image/jpeg')).statusCode).toBe(204);
    expect(errorOf(await put(asked.uploadUrl, JPEG, 'image/jpeg'))).toEqual([
      404,
      'image_file_not_found',
    ]);
  });

  it('refuses a body over the ceiling and a type that is not accepted', async () => {
    const orderId = await performedOrder();
    const asked = (
      await request(orderId, { fileName: 'a.jpg', contentType: 'image/jpeg', size: 10 })
    ).json<Upload>();
    const huge = Buffer.alloc(26 * 1024 * 1024);
    expect((await put(asked.uploadUrl, huge, 'image/jpeg')).statusCode).toBe(413);
    expect((await put(asked.uploadUrl, JPEG, 'application/x-msdownload')).statusCode).toBe(415);
  });

  it('lists the files of a study with their state', async () => {
    const orderId = await performedOrder();
    await uploaded(orderId);
    await uploaded(orderId, PDF, 'application/pdf');
    const page = (await get(`/radiology/orders/${orderId}/images`, { user: reader })).json<{
      items: { status: string; contentType: string }[];
      nextCursor: null;
    }>();
    expect(page.items.map((each) => each.contentType)).toEqual(['image/jpeg', 'application/pdf']);
    expect(page.nextCursor).toBeNull();
  });
});

describe('the hospital boundary', () => {
  it('shows another hospital nothing, and one link opens only its own file', async () => {
    const orderId = await performedOrder();
    const upload = await uploaded(orderId);
    await queue.drain();
    const other = { tenant: clinic, user: clinicRadiologist };
    expect(errorOf(await get(`/radiology/images/${upload.image.id}/download-url`, other))).toEqual([
      404,
      'image_not_found',
    ]);
    expect(errorOf(await get(`/radiology/orders/${orderId}/images`, other))).toEqual([
      404,
      'order_not_found',
    ]);
    const link = (await get(`/radiology/images/${upload.image.id}/download-url`)).json<{
      url: string;
    }>();
    const elsewhere = link.url.replace(upload.image.id, randomUUID());
    expect(errorOf(await app.inject({ url: elsewhere }))).toEqual([404, 'image_file_not_found']);
    // An upload signature does not open a download.
    const asked = (
      await request(await performedOrder(), {
        fileName: 'a.jpg',
        contentType: 'image/jpeg',
        size: 10,
      })
    ).json<Upload>();
    const query = asked.uploadUrl.split('?')[1] ?? '';
    const swapped = await app.inject({ url: `/imaging-files/${asked.image.id}?${query}` });
    expect(errorOf(swapped)).toEqual([404, 'image_file_not_found']);
  });

  it('keeps one hospital’s rows out of reach of another under row-level security', async () => {
    const orderId = await performedOrder();
    const upload = await uploaded(orderId);
    const find = (client: pg.ClientBase) =>
      client.query('select id from imaging_images where id = $1', [upload.image.id]);
    expect((await asTenantSql(pool, clinic.id, find)).rowCount).toBe(0);
    expect((await asTenantSql(pool, hospital.id, find)).rowCount).toBe(1);
    const source = (
      await pool.query<Record<string, string>>(
        `select study_id, order_id, encounter_id, patient_id, created_by
         from imaging_images where id = $1`,
        [upload.image.id],
      )
    ).rows[0];
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into imaging_images (tenant_id, study_id, order_id, encounter_id, patient_id,
             file_name, content_type, size_bytes, created_by)
           values ($1, $2, $3, $4, $5, 'x', 'image/png', 1, $6)`,
          [
            hospital.id,
            source?.study_id,
            source?.order_id,
            source?.encounter_id,
            source?.patient_id,
            source?.created_by,
          ],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('direct links to the bucket (#765)', () => {
  const direct = async <T>(run: () => Promise<T>): Promise<T> => {
    app.config.S3_DIRECT_LINKS = true;
    try {
      return await run();
    } finally {
      app.config.S3_DIRECT_LINKS = false;
    }
  };

  it('uploads straight to the bucket, is checked on completion and downloads from the bucket', async () => {
    if (!files.isS3) return; // needs an S3-compatible service (S3_TEST_ENDPOINT)
    await direct(async () => {
      const orderId = await performedOrder();
      const asked = (
        await request(orderId, {
          fileName: 'chest.jpg',
          contentType: 'image/jpeg',
          size: JPEG.length,
        })
      ).json<Upload & { direct?: boolean }>();
      expect(asked.direct).toBe(true);
      expect(asked.uploadUrl).toMatch(/^https?:\/\/.*X-Amz-Signature=/);
      expect(await statusOf(asked.image.id)).toBe('pending');
      const complete = `/radiology/images/${asked.image.id}/complete`;

      // Nothing has arrived yet.
      expect(errorOf(await post(complete, {}))).toEqual([409, 'image_not_received']);

      // The signature covers the type and the size: the bucket refuses anything else.
      const wrongType = await fetch(asked.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: JPEG,
      });
      expect(wrongType.ok).toBe(false);
      const wrongSize = await fetch(asked.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: Buffer.concat([JPEG, JPEG]),
      });
      expect(wrongSize.ok).toBe(false);

      const sent = await fetch(asked.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: JPEG,
      });
      expect(sent.ok).toBe(true);

      // Another hospital cannot complete it; the owner can, and twice is harmless.
      expect(
        (await post(complete, {}, { tenant: clinic, user: clinicRadiologist })).statusCode,
      ).toBe(404);
      expect((await post(complete, {})).statusCode).toBe(200);

      expect(await statusOf(asked.image.id)).toBe('scanning');
      expect((await post(complete, {})).statusCode).toBe(200);
      await queue.drain();
      expect(await statusOf(asked.image.id)).toBe('clean');

      const link = (await get(`/radiology/images/${asked.image.id}/download-url`)).json<{
        url: string;
      }>();
      expect(link.url).toMatch(/^https?:\/\/.*X-Amz-Signature=/);
      const file = await fetch(link.url);
      expect(Buffer.from(await file.arrayBuffer()).equals(JPEG)).toBe(true);
      expect(file.headers.get('content-type')).toBe('image/jpeg');
      expect(file.headers.get('content-disposition')).toContain('chest.jpg');
    });
  });

  it('deletes a file that is not what was announced and lets it be sent again', async () => {
    if (!files.isS3) return;
    await direct(async () => {
      const orderId = await performedOrder();
      const fake = Buffer.alloc(JPEG.length, 7);
      const asked = (
        await request(orderId, { fileName: 'x.jpg', contentType: 'image/jpeg', size: fake.length })
      ).json<Upload>();
      await fetch(asked.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: fake,
      });
      const complete = `/radiology/images/${asked.image.id}/complete`;
      expect(errorOf(await post(complete, {}))).toEqual([415, 'file_type_mismatch']);
      expect(await statusOf(asked.image.id)).toBe('pending');
      expect(errorOf(await post(complete, {}))).toEqual([409, 'image_not_received']);
    });
  });
});

describe('uploads asked for and never sent (#560)', () => {
  it('closes an old pending request and leaves a recent one and a received file alone', async () => {
    const orderId = await performedOrder();
    const ask = async () =>
      (
        await request(orderId, { fileName: 'a.jpg', contentType: 'image/jpeg', size: JPEG.length })
      ).json<Upload>();
    const old = await ask();
    const recent = await ask();
    const received = await uploaded(orderId);
    await pool.query(
      "update imaging_images set created_at = now() - interval '2 hours' where id = $1",
      [old.image.id],
    );
    const { closeUnsentImages } = await import('./images.js');
    expect(await closeUnsentImages(app)).toBe(1);
    expect(await statusOf(old.image.id)).toBe('failed');
    expect(await statusOf(recent.image.id)).toBe('pending');
    expect(await statusOf(received.image.id)).toBe('scanning');
    expect(await closeUnsentImages(app)).toBe(0);
  });
});
