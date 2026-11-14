import pg from 'pg';
const c = new pg.Client('postgres://mediflow:mediflow@localhost:5432/mediflow_test_907');
await c.connect();
await c.query("delete from patients where created_by='load'");
await c.query(
  "delete from tenants where id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222')",
);
await c.query('vacuum full patients');
await c.end();
