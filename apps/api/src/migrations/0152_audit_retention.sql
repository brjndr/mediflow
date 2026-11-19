-- #1065: retention of the audit log. Old monthly partitions are archived to the file store and then
-- dropped by the worker role. Rows cannot be deleted one by one (the append-only trigger), so a
-- whole partition is the unit. Platform-owned, with no tenant_id: it describes files, not hospitals.

-- One row per archived month, written once after every file is stored and checked. The worker can
-- add a row but never change one, so the row the drop trusts cannot be rewritten.
CREATE TABLE audit_archives (
  month date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  -- [{ "key": file key, "rows": n, "sha256": hex }], one entry per file of the month.
  parts jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON audit_archives TO mediflow_worker;

-- The months that have a partition and end before `cutoff` (a first of a month), oldest first.
-- Never the default partition.
CREATE FUNCTION audit_partitions_before(cutoff date) RETURNS SETOF date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT to_date(substr(c.relname, 11), 'YYYY_MM')
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'audit_log'::regclass
      AND c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
      AND to_date(substr(c.relname, 11), 'YYYY_MM') < cutoff
    ORDER BY 1
  $$;

-- How many rows a month's partition holds, counted on its own.
CREATE FUNCTION audit_partition_count(month date) RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  total bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', 'audit_log_' || to_char(date_trunc('month', month), 'YYYY_MM'))
    INTO total;
  RETURN total;
END
$$;

-- One page of a month's rows as JSON, after the given id (keyset), for the archive file. It reads
-- the month's own partition, so the file holds exactly what the partition holds whatever the
-- session time zone.
CREATE FUNCTION audit_partition_page(month date, after_id uuid, page_size int)
  RETURNS TABLE (id uuid, doc jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT a.id, to_jsonb(a) FROM %I a WHERE ($1 IS NULL OR a.id > $1) ORDER BY a.id LIMIT $2',
    'audit_log_' || to_char(date_trunc('month', month), 'YYYY_MM')
  ) USING after_id, least(page_size, 50000);
END
$$;

-- Detaches and drops one month's partition, but only when it ends before `cutoff`, it is archived
-- with the same row count, and it still holds exactly that many rows. The partition is locked
-- first, so nothing can be added between the count and the drop. Every lock waits at most 5
-- seconds: a busy moment fails the month, the next weekly run tries again, and the API is never
-- left queued behind it. (DETACH ... CONCURRENTLY cannot run inside a function.)
CREATE FUNCTION audit_retire_partition(month date, cutoff date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  first_day date := date_trunc('month', month)::date;
  partition_name text := 'audit_log_' || to_char(first_day, 'YYYY_MM');
  archived bigint;
  actual bigint;
BEGIN
  IF first_day >= cutoff THEN
    RAISE EXCEPTION 'audit partition % is inside the retention period', partition_name;
  END IF;
  SELECT row_count INTO archived FROM audit_archives WHERE audit_archives.month = first_day;
  IF archived IS NULL THEN
    RAISE EXCEPTION 'audit partition % is not archived', partition_name;
  END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', partition_name);
  EXECUTE format('SELECT count(*) FROM %I', partition_name) INTO actual;
  IF actual <> archived THEN
    RAISE EXCEPTION 'audit partition % changed since it was archived', partition_name;
  END IF;
  EXECUTE format('ALTER TABLE audit_log DETACH PARTITION %I', partition_name);
  EXECUTE format('DROP TABLE %I', partition_name);
END
$$;

REVOKE EXECUTE ON FUNCTION audit_partitions_before(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_partition_count(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_partition_page(date, uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_retire_partition(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_partitions_before(date) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION audit_partition_count(date) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION audit_partition_page(date, uuid, int) TO mediflow_worker;
GRANT EXECUTE ON FUNCTION audit_retire_partition(date, date) TO mediflow_worker;
