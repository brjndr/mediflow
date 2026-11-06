-- Follow-ups to the outbox and the audit log (#253).

-- The purge job deletes dispatched events older than the retention period; without an index that
-- would read the whole table every night.
CREATE INDEX outbox_dispatched ON outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;

-- How many audit rows sit in the default partition, which should stay empty. The worker role has no
-- row-level security policy on the partitions, so it could not count them itself; this function
-- only returns a number, and only that role may call it.
CREATE FUNCTION audit_default_rows() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT count(*) FROM audit_log_default $$;

REVOKE EXECUTE ON FUNCTION audit_default_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_default_rows() TO mediflow_worker;
