-- Tamper evidence for the audit log (#1081).
--
-- The log is sealed in batches per hospital: a seal covers every row whose transaction id falls in
-- [xid_from, xid_to), carries their count, a SHA-256 of their content worked out here, and an
-- HMAC over that, the range and the previous seal, made by the API with AUDIT_SEAL_KEY, a key the
-- database never sees. A row changed, removed or slipped into a sealed range no longer matches;
-- someone with the whole database can drop triggers but cannot make a matching seal without the
-- key. It detects, it does not prevent (core/audit/seal.ts).
--
-- Why transaction ids and not times: a row's `at` is when its transaction began, so a long one can
-- commit rows into a time window already sealed. A transaction id below the oldest one still
-- running belongs to a transaction that has ended, so a range up to that point can never gain a
-- row honestly.

-- The id of the transaction that wrote the row. Rows written before this migration have none and
-- count as 0 (`coalesce(xid, '0')` everywhere below), so they fall in each hospital's first seal.
ALTER TABLE audit_log ADD COLUMN xid xid8 DEFAULT pg_current_xact_id();
CREATE INDEX audit_log_tenant_xid ON audit_log (tenant_id, (coalesce(xid, '0'::xid8)));

CREATE TABLE audit_seal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: like the audit log it seals, it outlives the hospital.
  tenant_id uuid NOT NULL,
  xid_from xid8 NOT NULL,
  xid_to xid8 NOT NULL CHECK (xid_to > xid_from),
  row_count bigint NOT NULL CHECK (row_count > 0),
  -- The earliest `at` among the rows: a seal reaching into a retired month is no longer checked.
  min_at timestamptz NOT NULL,
  digest bytea NOT NULL CHECK (length(digest) = 32),
  prev_seal bytea CHECK (length(prev_seal) = 32),
  seal bytea NOT NULL CHECK (length(seal) = 32),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  -- One chain per hospital: two seals cannot start at the same place.
  UNIQUE (tenant_id, xid_from)
);
CREATE INDEX audit_seal_tenant_to ON audit_seal (tenant_id, xid_to);
SELECT enable_tenant_rls('audit_seal', 'SELECT');

CREATE FUNCTION audit_seal_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_seal is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER audit_seal_no_change BEFORE UPDATE OR DELETE ON audit_seal
  FOR EACH ROW EXECUTE FUNCTION audit_seal_immutable();
CREATE TRIGGER audit_seal_no_truncate BEFORE TRUNCATE ON audit_seal
  FOR EACH STATEMENT EXECUTE FUNCTION audit_seal_immutable();

-- Only the sealing job writes seals, and it reads them to chain and to verify.
CREATE POLICY worker_seal ON audit_seal FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON audit_seal TO mediflow_worker;

-- The hospitals with rows to seal below `upto`, where their next seal starts (0 for the first)
-- and the seal it follows.
CREATE FUNCTION audit_seal_due(upto xid8)
  RETURNS TABLE (tenant_id uuid, xid_from xid8, prev_seal bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  WITH heads AS (
    SELECT DISTINCT ON (s.tenant_id) s.tenant_id, s.xid_to, s.seal
    FROM audit_seal s
    ORDER BY s.tenant_id, s.xid_to DESC
  )
  SELECT t.id, coalesce(h.xid_to, '0'::xid8), h.seal
  FROM tenants t
  LEFT JOIN heads h ON h.tenant_id = t.id
  WHERE EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.tenant_id = t.id
      AND coalesce(a.xid, '0'::xid8) >= coalesce(h.xid_to, '0'::xid8)
      AND coalesce(a.xid, '0'::xid8) < upto
  )
$$;

-- What a seal covers: the count, the earliest `at` and a SHA-256 of the rows in order. Each row is
-- a fixed list of its columns, so a column added to audit_log later does not change old digests,
-- and times are written in UTC whatever the session's zone.
CREATE FUNCTION audit_seal_digest(tenant uuid, from_xid xid8, to_xid xid8)
  RETURNS TABLE (row_count bigint, min_at timestamptz, digest bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC'
  AS $$
  SELECT count(*),
         min(a.at),
         digest(
           coalesce(
             string_agg(
               jsonb_build_array(
                 a.id, a.tenant_id, a.at, a.actor_id, a.action, a.entity, a.entity_id,
                 a.request_id, a.detail, a.xid::text
               )::text,
               E'\n' ORDER BY coalesce(a.xid, '0'::xid8), a.id
             ),
             ''
           ),
           'sha256'
         )
  FROM audit_log a
  WHERE a.tenant_id = tenant
    AND coalesce(a.xid, '0'::xid8) >= from_xid
    AND coalesce(a.xid, '0'::xid8) < to_xid
$$;

REVOKE EXECUTE ON FUNCTION audit_seal_due(xid8) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_seal_digest(uuid, xid8, xid8) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_seal_due(xid8) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION audit_seal_digest(uuid, xid8, xid8) TO mediflow_worker;
