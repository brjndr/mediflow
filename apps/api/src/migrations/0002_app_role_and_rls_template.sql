-- The role every request runs as. It is not a superuser and cannot bypass row-level security,
-- so the policies below are the only way it sees tenant data. The tenant hook switches to it
-- with SET LOCAL ROLE at the start of each request's transaction.
--
-- In production the API should also connect as a login role that is itself restricted (a member
-- of mediflow_app, not a superuser, not the table owner), so that even a RESET ROLE cannot
-- escape. Migrations run under a separate, more privileged login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_app') THEN
    CREATE ROLE mediflow_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- The connecting role must be able to switch to it.
GRANT mediflow_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_app;

-- The tenant of the current transaction, set by the tenant hook from the server-side session.
-- Returns NULL when none is set, and a comparison with NULL is never true: with no tenant, every
-- policy hides every row.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_tenant_id() TO mediflow_app;

-- The row-level security template for a tenant-owned table. Call it in the migration that
-- creates the table:
--
--   CREATE TABLE patients (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     tenant_id uuid NOT NULL REFERENCES tenants (id),
--     ...
--   );
--   CREATE INDEX patients_tenant_mrn ON patients (tenant_id, mrn);
--   SELECT enable_tenant_rls('patients');
--
-- It refuses a table without a `tenant_id uuid NOT NULL` column or without an index that starts
-- with tenant_id. It then enables and FORCES row-level security (forced, so the table owner is
-- bound by it too), adds one policy for reads and writes, and grants the app role the listed
-- privileges. USING hides other tenants' rows from SELECT, UPDATE and DELETE; WITH CHECK rejects
-- an INSERT or UPDATE that would give a row to another tenant.
CREATE FUNCTION enable_tenant_rls(
  target regclass,
  privileges text DEFAULT 'SELECT, INSERT, UPDATE, DELETE'
) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_attribute
    WHERE attrelid = target AND attname = 'tenant_id' AND NOT attisdropped
      AND atttypid = 'uuid'::regtype AND attnotnull
  ) THEN
    RAISE EXCEPTION 'Table % needs a "tenant_id uuid NOT NULL" column', target;
  END IF;

  IF NOT EXISTS (
    SELECT FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = target AND a.attname = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'Table % needs an index that starts with tenant_id', target;
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO mediflow_app '
    'USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    target
  );
  EXECUTE format('GRANT %s ON %s TO mediflow_app', privileges, target);
END
$$;
