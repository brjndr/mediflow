-- A database role of its own for the hospital deletion job (BE-15m, #999).
--
-- The job deletes every row of an offboarded hospital with the append-only triggers switched off
-- (session_replication_role = replica), so it needs a privilege no request has, and it deletes
-- across the whole database with the tenant_id of one hospital in each statement. Until now it
-- ran on the API's own login. It becomes a role like mediflow_worker: NOLOGIN, switched to with
-- SET LOCAL ROLE, granted to a login of its own in production (DELETION_DATABASE_URL) and not to
-- the API's login, so a flaw in a request can never delete a hospital.
--
-- It bypasses row-level security (the one role that does, besides the migrating login): the
-- deletion reads and deletes rows of a hospital whose session is closed. It may read and delete
-- every table, change only what the job updates (the hospital's status, the sessions that named
-- it, its own run) and write the platform trail. It cannot insert into patient tables, alter a
-- table or create anything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_deletion') THEN
    CREATE ROLE mediflow_deletion NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_deletion TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_deletion;

GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA public TO mediflow_deletion;
-- Tables added later: read and delete only, like these.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, DELETE ON TABLES TO mediflow_deletion;

GRANT UPDATE ON tenants, sessions, tenant_deletions TO mediflow_deletion;
GRANT INSERT ON platform_audit_log TO mediflow_deletion;

-- Turning the triggers off is a privilege of its own from PostgreSQL 15 (a superuser before it,
-- which is why a production login on 14 or older cannot be made safe: upgrade first).
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'GRANT SET ON PARAMETER session_replication_role TO mediflow_deletion';
  END IF;
END
$$;
