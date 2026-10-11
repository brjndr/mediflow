-- Hardening of the audit log partitions (follows 0007 in the same change).

-- Every partition rejects TRUNCATE, not only the parent: Postgres does not copy statement
-- triggers to partitions, and a partition can be truncated directly. New partitions get the guard
-- from audit_secure_partition; the existing ones are given it here.
CREATE OR REPLACE FUNCTION audit_secure_partition(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()',
    target
  );
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO mediflow_app '
    'USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    target
  );
END
$$;

DO $$
DECLARE
  partition regclass;
BEGIN
  FOR partition IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'audit_log'::regclass
  LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()',
      partition
    );
  END LOOP;
END
$$;

-- Creating a partition needs to own audit_log. The API's login does not (0002 keeps it a
-- non-owner), so the function runs as the migrating login that does, with a pinned search_path,
-- and only mediflow_worker (the role of background work) may call it.
CREATE OR REPLACE FUNCTION ensure_audit_partition(month date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  first_day date := date_trunc('month', month)::date;
  partition_name text := 'audit_log_' || to_char(first_day, 'YYYY_MM');
BEGIN
  IF to_regclass(partition_name) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    (first_day::timestamp AT TIME ZONE 'UTC'),
    ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC')
  );
  PERFORM audit_secure_partition(partition_name::regclass);
END
$$;

REVOKE EXECUTE ON FUNCTION ensure_audit_partition(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_secure_partition(regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_partition(date) TO mediflow_worker;
