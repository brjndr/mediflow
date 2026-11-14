-- Patient search: words shorter than three characters (#879, follows #864).
--
-- A word under three characters has no trigram, so the GIN index cannot serve it and the search
-- read every row of the hospital (0.3 s at 2,000,000 patients). Such a word now matches the
-- start of the first or the last name, which two btree indexes serve; words of three or more
-- characters keep matching anywhere in the name or MRN through the trigram index.
GRANT SELECT (first_name_lower, last_name_lower) ON patients TO mediflow_search;

CREATE INDEX patients_tenant_first_prefix ON patients (tenant_id, first_name_lower text_pattern_ops);
CREATE INDEX patients_tenant_last_prefix ON patients (tenant_id, last_name_lower text_pattern_ops);

-- Same signature, owner and grants as in 0114 (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION patient_search_ids(words text[], phone text, legacy text, merged_away boolean)
  RETURNS SETOF uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  text_match text := 'false';
  alternatives text[] := ARRAY[]::text[];
  word_count int := coalesce(array_length(words, 1), 0);
BEGIN
  IF word_count > 0 THEN
    -- A word is a like pattern '%core%' with \ before % _ \. Under three characters of core it
    -- becomes a prefix of a name part: 'core%'.
    text_match := '(' || (
      SELECT string_agg(
        CASE WHEN length(replace(substr(words[i], 2, length(words[i]) - 2), '\', '')) < 3
          THEN format(
            '(first_name_lower like %L or last_name_lower like %L)',
            substr(words[i], 2, length(words[i]) - 2) || '%',
            substr(words[i], 2, length(words[i]) - 2) || '%')
          ELSE format('search_text like ($1)[%s]', i)
        END, ' and ' ORDER BY i)
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
