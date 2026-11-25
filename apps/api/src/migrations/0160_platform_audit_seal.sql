-- Seals for the platform audit log (#1092, follows 0153 and 0154).
--
-- The operators' trail is sealed as one chain, kept in `audit_seal` under the nil hospital id
-- (00000000-0000-0000-0000-000000000000), with the same layout, key and verification as a
-- hospital's. It has no hospital, so it has its own functions.

ALTER TABLE platform_audit_log ADD COLUMN xid xid8 DEFAULT pg_current_xact_id();
CREATE INDEX platform_audit_log_xid ON platform_audit_log ((coalesce(xid, '0'::xid8)));

-- A row's transaction id is its own, and the platform role cannot choose its time (see 0154).
CREATE FUNCTION platform_audit_log_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  NEW.xid := pg_current_xact_id();
  IF NEW.at IS DISTINCT FROM now()
     AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
  THEN
    RAISE EXCEPTION 'platform_audit_log.at is set by the database' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_audit_log_stamp BEFORE INSERT ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_stamp();

GRANT SELECT ON platform_audit_log TO mediflow_seal;

-- Where the platform's next seal starts (0 for the first) and the seal it follows; no row when
-- nothing below `upto` is unsealed.
CREATE FUNCTION platform_seal_due(upto xid8)
  RETURNS TABLE (xid_from xid8, prev_seal bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT coalesce(h.xid_to, '0'::xid8), h.seal
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT s.xid_to, s.seal FROM audit_seal s
    WHERE s.tenant_id = '00000000-0000-0000-0000-000000000000'
    ORDER BY s.xid_to DESC
    LIMIT 1
  ) h ON true
  WHERE EXISTS (
    SELECT 1 FROM platform_audit_log a
    WHERE coalesce(a.xid, '0'::xid8) >= coalesce(h.xid_to, '0'::xid8)
      AND coalesce(a.xid, '0'::xid8) < upto
  )
$$;

CREATE FUNCTION platform_seal_end(from_xid xid8, upto xid8, max_rows int)
  RETURNS xid8
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  boundary xid8;
BEGIN
  SELECT b.x INTO boundary FROM (
    SELECT coalesce(a.xid, '0'::xid8) AS x FROM platform_audit_log a
    WHERE coalesce(a.xid, '0'::xid8) >= from_xid AND coalesce(a.xid, '0'::xid8) < upto
    ORDER BY 1
    OFFSET max_rows LIMIT 1
  ) b;
  IF boundary IS NULL THEN
    RETURN upto;
  END IF;
  IF boundary > from_xid THEN
    RETURN boundary;
  END IF;
  SELECT min(coalesce(a.xid, '0'::xid8)) INTO boundary FROM platform_audit_log a
  WHERE coalesce(a.xid, '0'::xid8) > from_xid AND coalesce(a.xid, '0'::xid8) < upto;
  RETURN coalesce(boundary, upto);
END
$$;

-- The same shape as audit_seal_digest: a fixed list of the columns, times in UTC.
CREATE FUNCTION platform_seal_digest(from_xid xid8, to_xid xid8)
  RETURNS TABLE (row_count bigint, min_at timestamptz, digest bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC'
  AS $$
  SELECT count(*),
         min(a.at),
         audit_seal_hash(
           jsonb_build_array(
             a.id, a.at, a.actor_id, a.action, a.entity, a.entity_id, a.hospital_id,
             a.request_id, a.detail, a.xid::text
           )::text
           ORDER BY coalesce(a.xid, '0'::xid8), a.id
         )
  FROM platform_audit_log a
  WHERE coalesce(a.xid, '0'::xid8) >= from_xid
    AND coalesce(a.xid, '0'::xid8) < to_xid
$$;

-- True when rows older than `older_than` are under no seal: sealing has stopped.
CREATE FUNCTION platform_seal_lagging(older_than interval)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_audit_log a
    WHERE coalesce(a.xid, '0'::xid8) >= coalesce(
        (SELECT s.xid_to FROM audit_seal s
         WHERE s.tenant_id = '00000000-0000-0000-0000-000000000000'
         ORDER BY s.xid_to DESC LIMIT 1), '0'::xid8)
      AND a.at < now() - older_than
  )
$$;

ALTER FUNCTION platform_seal_due(xid8) OWNER TO mediflow_seal;
ALTER FUNCTION platform_seal_end(xid8, xid8, int) OWNER TO mediflow_seal;
ALTER FUNCTION platform_seal_digest(xid8, xid8) OWNER TO mediflow_seal;
ALTER FUNCTION platform_seal_lagging(interval) OWNER TO mediflow_seal;
REVOKE EXECUTE ON FUNCTION platform_seal_due(xid8) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION platform_seal_end(xid8, xid8, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION platform_seal_digest(xid8, xid8) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION platform_seal_lagging(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_seal_due(xid8) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION platform_seal_end(xid8, xid8, int) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION platform_seal_digest(xid8, xid8) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION platform_seal_lagging(interval) TO mediflow_worker;

-- The hospitals that still exist: their seals are kept, and compared with the write-once copies.
-- A deleted hospital's seals go with its data (the copies stay, to the end of their retention).
CREATE FUNCTION audit_seal_live_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT t.id FROM tenants t WHERE t.status <> 'deleted' $$;
ALTER FUNCTION audit_seal_live_tenants() OWNER TO mediflow_seal;
REVOKE EXECUTE ON FUNCTION audit_seal_live_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_seal_live_tenants() TO mediflow_worker;
