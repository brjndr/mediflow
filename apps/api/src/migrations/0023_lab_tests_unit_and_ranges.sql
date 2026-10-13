-- Lab tests, after review of 0022 (BE-17c).

-- The reference ranges of a test are numbers in its unit. 0022 kept a test with ranges numeric,
-- and let its unit change under them: ranges entered in mg/dL stood for a test now in mmol/L.
-- A test with ranges keeps its unit until they are removed, as it keeps being numeric.
CREATE OR REPLACE FUNCTION lab_tests_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'A test''s hospital, identity, code and kind cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.result_type <> 'numeric' OR NEW.unit IS DISTINCT FROM OLD.unit) AND EXISTS (
    SELECT FROM lab_test_ranges WHERE tenant_id = NEW.tenant_id AND lab_test_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A test with reference ranges stays numeric and keeps its unit'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  -- Each of the two versions is the database's to count, whatever the statement set it to. A
  -- statement that moves ranges_version is a save of the ranges and leaves the test's own
  -- version; any other is a change of the test (or of a panel's components).
  IF NEW.ranges_version IS DISTINCT FROM OLD.ranges_version THEN
    NEW.ranges_version := OLD.ranges_version + 1;
    NEW.version := OLD.version;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- 0022 checked that a range belongs to a numeric single test without holding the test: a range
-- added and the test turned into a text test at the same moment could both go through. The check
-- now holds the test's row until the transaction ends, so the two take their turn.
CREATE OR REPLACE FUNCTION lab_test_ranges_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM lab_tests
  WHERE tenant_id = NEW.tenant_id AND id = NEW.lab_test_id
    AND kind = 'test' AND result_type = 'numeric'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a numeric test has reference ranges' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
