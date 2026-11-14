-- Patient search: the page for two or more words of one or two characters, in name order (#907).
--
-- Follows #899. "a r" matched 35,000 rows at 2,000,000 patients and the page sorted all of them
-- (about 1 s). Every match has a word that starts the last name, or else all its words start the
-- first name, which only words that begin one another can do ("r ra"). So the page is merged from
-- the same ordered btree streams as `patient_search_short_page`: one stream of the last names that
-- start with each word, each row tested against the other words (each must start the first or the
-- last name, as the search itself requires), and one stream of first names for the second case.
-- Every stream is read in name order and stopped after the page, so the cost follows the last
-- names that start with a word, not the number of matches. Same indexes, same definer rules: it
-- filters `tenant_id = app_tenant_id()` itself and returns ids, which the caller reads again
-- under row-level security and its scope.
CREATE FUNCTION patient_search_short_words_page(
  words text[], legacy text, after_last text, after_first text, after_id uuid, lim int)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id FROM (
    (SELECT s.id, s.l, s.f FROM generate_series(1, cardinality(words)) i
     CROSS JOIN LATERAL (
       SELECT id, last_name_lower COLLATE "C" AS l, first_name_lower COLLATE "C" AS f
       FROM patients
       WHERE tenant_id = app_tenant_id() AND merged_into_id IS NULL
         AND last_name_lower COLLATE "C" >= words[i]
         AND last_name_lower COLLATE "C" < words[i] || chr(1114111)
         AND (after_id IS NULL
           OR (last_name_lower COLLATE "C", first_name_lower COLLATE "C", id)
              > (after_last COLLATE "C", after_first COLLATE "C", after_id))
         AND NOT EXISTS (SELECT 1 FROM unnest(words) WITH ORDINALITY w(x, k)
           WHERE k <> i AND NOT (starts_with(first_name_lower, x) OR starts_with(last_name_lower, x)))
       ORDER BY l, f, id LIMIT lim) s)
    UNION
    -- Only when every word begins the longest one, so that one first name can start them all.
    (SELECT id, l, f FROM (
       SELECT id, last_name_lower COLLATE "C" AS l, first_name_lower COLLATE "C" AS f
       FROM patients, (SELECT x AS lead FROM unnest(words) x ORDER BY length(x) DESC LIMIT 1) longest
       WHERE tenant_id = app_tenant_id() AND merged_into_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(words) x WHERE NOT starts_with(lead, x))
         AND left(first_name_lower, 1) = left(lead, 1)
         AND first_name_lower COLLATE "C" >= lead
         AND first_name_lower COLLATE "C" < lead || chr(1114111)
         AND (after_id IS NULL
           OR (last_name_lower COLLATE "C", first_name_lower COLLATE "C", id)
              > (after_last COLLATE "C", after_first COLLATE "C", after_id))
       ORDER BY l, f, id LIMIT lim) first_names)
    UNION
    (SELECT id, l, f FROM (
       SELECT id, last_name_lower COLLATE "C" AS l, first_name_lower COLLATE "C" AS f
       FROM patients
       WHERE tenant_id = app_tenant_id() AND merged_into_id IS NULL
         AND legacy_id = legacy
         AND (after_id IS NULL
           OR (last_name_lower COLLATE "C", first_name_lower COLLATE "C", id)
              > (after_last COLLATE "C", after_first COLLATE "C", after_id))
       ORDER BY l, f, id LIMIT lim) legacy_match)
  ) merged
  ORDER BY l, f, id LIMIT lim
$$;

ALTER FUNCTION patient_search_short_words_page(text[], text, text, text, uuid, int) OWNER TO mediflow_search;
REVOKE ALL ON FUNCTION patient_search_short_words_page(text[], text, text, text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_search_short_words_page(text[], text, text, text, uuid, int) TO mediflow_app;
