-- Patient search: the page for one word of one or two characters, in name order (#899).
--
-- At 2,000,000 patients "a" matched 254,000 rows and the page sorted all of them (3 to 4 s).
-- Here the first rows are read in sort order from two btree indexes and the read stops after the
-- page: one stream for last names that start with the word, one for first names, merged. The
-- order is the byte order of the lowercased name (collation "C"), so the indexes can serve it.
-- It runs as the search owner (the ordering and prefix tests use operators row-level security
-- would keep from the index), filters `tenant_id = app_tenant_id()` itself and returns ids,
-- which the caller reads again under row-level security and its scope.
CREATE INDEX patients_tenant_last_ordered
  ON patients (tenant_id, (last_name_lower COLLATE "C"), (first_name_lower COLLATE "C"), id)
  WHERE merged_into_id IS NULL;
-- Led by the first letter so the first names that start with it come out in last-name order.
CREATE INDEX patients_tenant_first_ordered
  ON patients (tenant_id, (left(first_name_lower, 1)), (last_name_lower COLLATE "C"),
    (first_name_lower COLLATE "C"), id)
  WHERE merged_into_id IS NULL;

-- The ids of the first `lim` live patients after the given position (null for the first page)
-- whose first or last name starts with `word` (1 or 2 characters, lowercase, no pattern
-- characters), or whose legacy registration number is `legacy`, in (last name, first name, id)
-- order. With `lim` set to a cap plus one it also counts up to the cap.
CREATE FUNCTION patient_search_short_page(
  word text, legacy text, after_last text, after_first text, after_id uuid, lim int)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id FROM (
    (SELECT id, l, f FROM (
       SELECT id, last_name_lower COLLATE "C" AS l, first_name_lower COLLATE "C" AS f
       FROM patients
       WHERE tenant_id = app_tenant_id() AND merged_into_id IS NULL
         AND last_name_lower COLLATE "C" >= word
         AND last_name_lower COLLATE "C" < word || chr(1114111)
         AND (after_id IS NULL
           OR (last_name_lower COLLATE "C", first_name_lower COLLATE "C", id)
              > (after_last COLLATE "C", after_first COLLATE "C", after_id))
       ORDER BY l, f, id LIMIT lim) last_names)
    UNION
    (SELECT id, l, f FROM (
       SELECT id, last_name_lower COLLATE "C" AS l, first_name_lower COLLATE "C" AS f
       FROM patients
       WHERE tenant_id = app_tenant_id() AND merged_into_id IS NULL
         AND left(first_name_lower, 1) = left(word, 1)
         AND first_name_lower COLLATE "C" >= word
         AND first_name_lower COLLATE "C" < word || chr(1114111)
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

ALTER FUNCTION patient_search_short_page(text, text, text, text, uuid, int) OWNER TO mediflow_search;
REVOKE ALL ON FUNCTION patient_search_short_page(text, text, text, text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_search_short_page(text, text, text, text, uuid, int) TO mediflow_app;
