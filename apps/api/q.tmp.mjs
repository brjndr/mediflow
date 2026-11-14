import pg from 'pg';
const c = new pg.Client({
  connectionString: 'postgres://mediflow:mediflow@localhost:5432/mediflow_test_864',
});
await c.connect();
await c.query('begin');
await c.query('set local role mediflow_app');
try {
  console.log(
    (await c.query("select * from patient_search_ids(array['%a%'],null,'x',false)")).rowCount,
  );
} catch (e) {
  console.log(e.message);
}
