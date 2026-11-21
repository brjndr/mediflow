-- Audit seals, hardened after review (#1081, completes 0153).
--
-- A correction to 0153's comment: the `xid` default is stable, so rows already in the table read as
-- 0153's own transaction id (no rewrite) and fall in each hospital's first seal. NULL can only come
-- from an explicit insert by the owner; it counts as 0 everywhere.
--
-- 0153 builds audit_log_tenant_xid on every partition inside its transaction, which holds audit
-- inserts (and so PHI requests) while it builds: fine before go-live; on a large live log, build
-- it per partition concurrently first.

-- A row's transaction id is always its own, and the roles the app writes as cannot choose its time
-- either (refused: `at` picks the partition, so it cannot be changed here): a backdated or
-- post-dated row would otherwise be sealed as genuine, or never sealed. The owner (migrations,
-- tests that build old months) may still set `at`; it can do anything anyway.
CREATE FUNCTION audit_log_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  NEW.xid := pg_current_xact_id();
  IF NEW.at IS DISTINCT FROM now()
     AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
  THEN
    RAISE EXCEPTION 'audit_log.at is set by the database' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_log_stamp BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_stamp();

-- The daily check reads the seals made since its last run.
CREATE INDEX audit_seal_sealed_at ON audit_seal (sealed_at);

-- The seal functions read every hospital's rows. They belong to a role that bypasses row-level
-- security and can only read what they need, as patient search does (0114), so they work whatever
-- the migrating login is (a login under forced row-level security would see nothing and seal
-- nothing, silently).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_seal') THEN
    CREATE ROLE mediflow_seal NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_seal TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_seal;
GRANT SELECT ON audit_log, audit_seal TO mediflow_seal;
GRANT SELECT (id, status) ON tenants TO mediflow_seal;

-- A SHA-256 chain over the rows, one row at a time, so the memory used does not grow with the
-- range (0153 built one string of the whole range, which stops at 1 GB): state = sha256(state ||
-- row).
CREATE FUNCTION audit_seal_step(state bytea, line text) RETURNS bytea
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$ SELECT digest(state || convert_to(line, 'UTF8'), 'sha256') $$;
CREATE AGGREGATE audit_seal_hash(text) (SFUNC = audit_seal_step, STYPE = bytea, INITCOND = '');

-- The hospitals with rows to seal below `upto`, where their next seal starts (0 for the first)
-- and the seal it follows. Reads one seal per hospital (the newest, by index), and leaves out
-- deleted hospitals.
CREATE OR REPLACE FUNCTION audit_seal_due(upto xid8)
  RETURNS TABLE (tenant_id uuid, xid_from xid8, prev_seal bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT t.id, coalesce(h.xid_to, '0'::xid8), h.seal
  FROM tenants t
  LEFT JOIN LATERAL (
    SELECT s.xid_to, s.seal FROM audit_seal s
    WHERE s.tenant_id = t.id
    ORDER BY s.xid_to DESC
    LIMIT 1
  ) h ON true
  WHERE t.status <> 'deleted'
    AND EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.tenant_id = t.id
        AND coalesce(a.xid, '0'::xid8) >= coalesce(h.xid_to, '0'::xid8)
        AND coalesce(a.xid, '0'::xid8) < upto
    )
$$;

-- Where a seal from `from_xid` ends so it holds at most `max_rows` rows: at the transaction id of
-- the row after them (its rows go to the next seal), or `upto`. One transaction's rows are never
-- split, so a single transaction with more rows than that is sealed alone.
CREATE FUNCTION audit_seal_end(tenant uuid, from_xid xid8, upto xid8, max_rows int)
  RETURNS xid8
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  boundary xid8;
BEGIN
  SELECT b.x INTO boundary FROM (
    SELECT coalesce(a.xid, '0'::xid8) AS x FROM audit_log a
    WHERE a.tenant_id = tenant
      AND coalesce(a.xid, '0'::xid8) >= from_xid
      AND coalesce(a.xid, '0'::xid8) < upto
    ORDER BY 1
    OFFSET max_rows LIMIT 1
  ) b;
  IF boundary IS NULL THEN
    RETURN upto;
  END IF;
  IF boundary > from_xid THEN
    RETURN boundary;
  END IF;
  -- The first transaction alone is larger than a seal: it ends at the next transaction.
  SELECT min(coalesce(a.xid, '0'::xid8)) INTO boundary FROM audit_log a
  WHERE a.tenant_id = tenant
    AND coalesce(a.xid, '0'::xid8) > from_xid
    AND coalesce(a.xid, '0'::xid8) < upto;
  RETURN coalesce(boundary, upto);
END
$$;

-- What a seal covers: the count, the earliest `at` and the SHA-256 chain over the rows in order.
-- Each row is a fixed list of its columns, so a column added to audit_log later does not change old
-- digests, and times are written in UTC whatever the session's zone.
CREATE OR REPLACE FUNCTION audit_seal_digest(tenant uuid, from_xid xid8, to_xid xid8)
  RETURNS TABLE (row_count bigint, min_at timestamptz, digest bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC'
  AS $$
  SELECT count(*),
         min(a.at),
         audit_seal_hash(
           jsonb_build_array(
             a.id, a.tenant_id, a.at, a.actor_id, a.action, a.entity, a.entity_id,
             a.request_id, a.detail, a.xid::text
           )::text
           ORDER BY coalesce(a.xid, '0'::xid8), a.id
         )
  FROM audit_log a
  WHERE a.tenant_id = tenant
    AND coalesce(a.xid, '0'::xid8) >= from_xid
    AND coalesce(a.xid, '0'::xid8) < to_xid
$$;

-- Hospitals with rows older than `older_than` that no seal covers: sealing has stopped (the job is
-- not running, it cannot read the rows, or a transaction has been open that long).
CREATE FUNCTION audit_seal_lagging(older_than interval)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT t.id
  FROM tenants t
  LEFT JOIN LATERAL (
    SELECT s.xid_to FROM audit_seal s
    WHERE s.tenant_id = t.id
    ORDER BY s.xid_to DESC
    LIMIT 1
  ) h ON true
  WHERE t.status <> 'deleted'
    AND EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.tenant_id = t.id
        AND coalesce(a.xid, '0'::xid8) >= coalesce(h.xid_to, '0'::xid8)
        AND a.at < now() - older_than
    )
$$;

ALTER FUNCTION audit_seal_due(xid8) OWNER TO mediflow_seal;
ALTER FUNCTION audit_seal_end(uuid, xid8, xid8, int) OWNER TO mediflow_seal;
ALTER FUNCTION audit_seal_digest(uuid, xid8, xid8) OWNER TO mediflow_seal;
ALTER FUNCTION audit_seal_lagging(interval) OWNER TO mediflow_seal;
REVOKE EXECUTE ON FUNCTION audit_seal_end(uuid, xid8, xid8, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_seal_lagging(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_seal_end(uuid, xid8, xid8, int) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION audit_seal_lagging(interval) TO mediflow_worker;
