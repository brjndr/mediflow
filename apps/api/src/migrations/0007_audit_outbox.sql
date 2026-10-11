-- Audit log and transactional outbox (BE-06).
--
-- Both are written inside the request's own transaction, so they commit or roll back together
-- with the change they describe: a rolled-back request leaves no audit row and emits no event.

-- The role the outbox dispatcher runs as. It reads every hospital's pending events, which no
-- tenant role can, and it can do nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_worker') THEN
    CREATE ROLE mediflow_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_worker TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_worker;

-- Who did what to which record, per hospital. Append-only: the app role can only read and add
-- rows, and a trigger refuses any change even from the table owner. It is partitioned by month so
-- old months can be detached and moved to cheaper storage. There is deliberately no foreign key to
-- tenants: removing a hospital must not remove (or be blocked by) its audit trail.
-- The primary key includes the partition key, as Postgres requires.
CREATE TABLE audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 63),
  entity text NOT NULL CHECK (length(entity) BETWEEN 1 AND 63),
  entity_id text,
  request_id text,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at);
CREATE INDEX audit_log_tenant_entity ON audit_log (tenant_id, entity, entity_id, at);

CREATE FUNCTION audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

SELECT enable_tenant_rls('audit_log', 'SELECT, INSERT');

-- A partition is a table of its own, so it gets the same row-level security as the parent
-- (queries through the parent use the parent's policy; this closes direct access to a partition).
CREATE FUNCTION audit_secure_partition(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO mediflow_app '
    'USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    target
  );
END
$$;

-- Creates the partition for the month containing `month`, if it does not exist yet.
CREATE FUNCTION ensure_audit_partition(month date) RETURNS void
  LANGUAGE plpgsql
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

-- Rows outside every monthly partition land here instead of failing the request. The API creates
-- upcoming months ahead of time (a daily job), so it should stay empty.
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
SELECT audit_secure_partition('audit_log_default');

SELECT ensure_audit_partition((date_trunc('month', now()) + make_interval(months => m))::date)
FROM generate_series(-1, 12) AS m;

-- Domain events waiting to be handed to the job queue. Written in the request's transaction;
-- a dispatcher moves them to the queue and marks them done.
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event ~ '^[a-z]+(\.[a-z_]+)+$' AND length(event) <= 63),
  entity_id text,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  -- Failed hand-offs to the queue. The dispatcher stops retrying a row after a few (see dispatcher.ts).
  attempts int NOT NULL DEFAULT 0
);

CREATE INDEX outbox_tenant_occurred ON outbox (tenant_id, occurred_at);
CREATE INDEX outbox_pending ON outbox (occurred_at, id) WHERE dispatched_at IS NULL;

-- Tenant requests can only add events. They never read or change them.
SELECT enable_tenant_rls('outbox', 'INSERT');

CREATE POLICY worker_all ON outbox FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT ON outbox TO mediflow_worker;
GRANT UPDATE (dispatched_at, attempts) ON outbox TO mediflow_worker;
GRANT DELETE ON outbox TO mediflow_worker;
