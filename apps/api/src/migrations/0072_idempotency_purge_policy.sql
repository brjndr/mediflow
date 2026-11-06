-- The purge job only reads expires_at and deletes expired rows (0009 granted exactly that), so its
-- policy no longer covers INSERT and UPDATE.
DROP POLICY worker_purge ON idempotency_keys;
CREATE POLICY worker_purge_select ON idempotency_keys FOR SELECT TO mediflow_worker USING (true);
CREATE POLICY worker_purge_delete ON idempotency_keys FOR DELETE TO mediflow_worker USING (true);
