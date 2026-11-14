-- Patient search through a definer function and GIN trigram indexes (#864, decision in #259).
--
-- Under row-level security Postgres uses an index for a clause only when its operator is
-- leakproof, and LIKE is not, so the app role never used the gist trigram indexes and search read
-- every row of the hospital (1.0 s at 2,000,000 patients). The function below runs as an owner
-- that bypasses row-level security, filters `tenant_id = app_tenant_id()` itself (the tenant still
-- comes only from the session setting) and returns ids only. The caller reads the rows again
-- under row-level security, so a mistake here cannot show another hospital's row.
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_search') THEN
    CREATE ROLE mediflow_search NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_search TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_search;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO mediflow_search;
-- Only the columns the search reads.
GRANT SELECT (id, tenant_id, search_text, phone_digits, legacy_id, merged_into_id)
  ON patients TO mediflow_search;

CREATE INDEX patients_tenant_search_gin ON patients USING gin (tenant_id, search_text gin_trgm_ops);
CREATE INDEX patients_tenant_phone_search_gin ON patients USING gin (tenant_id, phone_digits gin_trgm_ops);
-- The gist versions were dropped in 0011; this is only a guard.
DROP INDEX IF EXISTS patients_tenant_search;
DROP INDEX IF EXISTS patients_tenant_phone_search;

-- Ids of the hospital's patients matching a term. `words` are like patterns, all of which must
-- match search_text (one `like` each: `like all (array)` does not use the index); `phone` is an
-- optional like pattern on the digits, `legacy` an optional exact legacy number. A record merged
-- away is returned only when `merged_away` is set. Null `words` matches nothing by text.
CREATE FUNCTION patient_search_ids(words text[], phone text, legacy text, merged_away boolean)
  RETURNS SETOF uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  text_match text := 'false';
  alternatives text[] := ARRAY[]::text[];
  word_count int := coalesce(array_length(words, 1), 0);
BEGIN
  IF word_count > 0 THEN
    text_match := '(' || (
      SELECT string_agg(format('search_text like ($1)[%s]', i), ' and ' ORDER BY i)
      FROM generate_series(1, word_count) AS i
    ) || ')';
    alternatives := array_append(alternatives, text_match);
  END IF;
  IF legacy IS NOT NULL THEN alternatives := array_append(alternatives, 'legacy_id = $3'); END IF;
  IF phone IS NOT NULL THEN alternatives := array_append(alternatives, 'phone_digits like $2'); END IF;
  IF cardinality(alternatives) = 0 THEN RETURN; END IF;
  RETURN QUERY EXECUTE
    'SELECT id FROM patients WHERE tenant_id = app_tenant_id() AND ((merged_into_id IS NOT NULL) = $4) AND ('
    || array_to_string(alternatives, ' or ') || ')'
    USING words, phone, legacy, merged_away;
END
$$;

CREATE FUNCTION patient_search_count(words text[], phone text, legacy text, merged_away boolean)
  RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT count(*) FROM patient_search_ids(words, phone, legacy, merged_away) $$;

ALTER FUNCTION patient_search_ids(text[], text, text, boolean) OWNER TO mediflow_search;
ALTER FUNCTION patient_search_count(text[], text, text, boolean) OWNER TO mediflow_search;
REVOKE ALL ON FUNCTION patient_search_ids(text[], text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION patient_search_count(text[], text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_search_ids(text[], text, text, boolean) TO mediflow_app;
GRANT EXECUTE ON FUNCTION patient_search_count(text[], text, text, boolean) TO mediflow_app;
