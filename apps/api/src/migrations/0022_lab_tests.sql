-- Lab tests (BE-17c): the tests and panels a laboratory offers, how each is collected and how its
-- result is read. Reference data: no patient data. A result will keep the name, unit and
-- reference range it was reported with, so a change here never changes a report.

CREATE TABLE lab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- The test's identity on orders and reports. Never changes (the trigger below).
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(code) <= 30),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 150),
  -- The section of the laboratory.
  department text NOT NULL CHECK (department IN (
    'biochemistry', 'haematology', 'microbiology', 'serology', 'hormones', 'pathology', 'other'
  )),
  -- A single test, or a panel: a named set of tests ordered together. Never changes: a test with
  -- results cannot become a panel.
  kind text NOT NULL CHECK (kind IN ('test', 'panel')),
  -- A number against a reference range, or text. A panel has no result of its own.
  result_type text NOT NULL CHECK (result_type IN ('numeric', 'text')),
  unit text CHECK (unit IS NULL OR (unit = btrim(unit) AND length(unit) BETWEEN 1 AND 30)),
  sample_type text NOT NULL CHECK (sample_type IN (
    'blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'sputum', 'csf', 'tissue', 'other'
  )),
  container text
    CHECK (container IS NULL OR (container = btrim(container) AND length(container) BETWEEN 1 AND 50)),
  turnaround_hours integer NOT NULL CHECK (turnaround_hours BETWEEN 1 AND 720),
  -- The service the test is charged as. Together with the hospital: foreign keys are checked
  -- without row-level security.
  service_id uuid,
  -- Archived, never deleted: it stays on the orders and reports that name it.
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The reference ranges are changed by other people at other times, so they have their own.
  ranges_version integer NOT NULL DEFAULT 1 CHECK (ranges_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Stored, so uniqueness, ordering and search are plain comparisons on a column.
  code_lower text GENERATED ALWAYS AS (lower(code)) STORED,
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  search_text text GENERATED ALWAYS AS (lower(code) || ' ' || lower(name)) STORED,
  CONSTRAINT lab_tests_panel_has_no_result CHECK (
    kind <> 'panel' OR (result_type = 'text' AND unit IS NULL)
  ),
  CONSTRAINT lab_tests_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  -- One test of a code per hospital, whatever its capitals, archived or not.
  CONSTRAINT lab_tests_code_taken UNIQUE (tenant_id, code_lower),
  CONSTRAINT lab_tests_tenant_id_id UNIQUE (tenant_id, id)
);

-- The list: a hospital's active (or archived) tests in name order.
CREATE INDEX lab_tests_tenant_list ON lab_tests (tenant_id, archived, name_lower, id);

-- No DELETE for the app role.
SELECT enable_tenant_rls('lab_tests', 'SELECT, INSERT, UPDATE');

-- The single tests a panel is made of, in the order they are reported.
CREATE TABLE lab_test_components (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  panel_id uuid NOT NULL,
  component_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 59),
  PRIMARY KEY (tenant_id, panel_id, component_id),
  CONSTRAINT lab_test_components_position UNIQUE (tenant_id, panel_id, position),
  CONSTRAINT lab_test_components_panel FOREIGN KEY (tenant_id, panel_id)
    REFERENCES lab_tests (tenant_id, id),
  CONSTRAINT lab_test_components_component FOREIGN KEY (tenant_id, component_id)
    REFERENCES lab_tests (tenant_id, id)
);

-- Which panels a test is part of: asked before a test is archived.
CREATE INDEX lab_test_components_by_component ON lab_test_components (tenant_id, component_id);

-- The components of a panel are replaced as a set, so the app role deletes here. No UPDATE.
SELECT enable_tenant_rls('lab_test_components', 'SELECT, INSERT, DELETE');

CREATE FUNCTION lab_test_components_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- A panel is made of single tests, whatever the code sends.
  IF NOT EXISTS (
    SELECT FROM lab_tests WHERE tenant_id = NEW.tenant_id AND id = NEW.panel_id AND kind = 'panel'
  ) OR NOT EXISTS (
    SELECT FROM lab_tests
    WHERE tenant_id = NEW.tenant_id AND id = NEW.component_id AND kind = 'test'
  ) THEN
    RAISE EXCEPTION 'A panel is made of single tests' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_test_components_guard BEFORE INSERT ON lab_test_components
  FOR EACH ROW EXECUTE FUNCTION lab_test_components_guard();

-- What is normal for one sex in one span of age. An age is kept as it is written, a value with
-- its unit, and never turned into a count of days: a patient reaches it on the calendar day that
-- lies that long after the date of birth. That two ranges for the same people never both hold is
-- a rule about every possible date of birth, which the API checks (features/lab-tests/age.ts).
CREATE TABLE lab_test_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  lab_test_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 59),
  -- Whom the row is for. A row for one sex is used before a row for any.
  sex text NOT NULL CHECK (sex IN ('any', 'male', 'female')),
  -- From this age, included, until that age, not included. No until: no upper age.
  age_from_value integer NOT NULL CHECK (age_from_value BETWEEN 0 AND 54750),
  age_from_unit text NOT NULL CHECK (age_from_unit IN ('days', 'weeks', 'months', 'years')),
  age_until_value integer CHECK (age_until_value BETWEEN 0 AND 54750),
  age_until_unit text CHECK (age_until_unit IN ('days', 'weeks', 'months', 'years')),
  low double precision,
  high double precision,
  -- At or below, and at or above, these a result is critical.
  critical_low double precision,
  critical_high double precision,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 150),
  CONSTRAINT lab_test_ranges_until CHECK ((age_until_value IS NULL) = (age_until_unit IS NULL)),
  CONSTRAINT lab_test_ranges_has_a_limit CHECK (low IS NOT NULL OR high IS NOT NULL),
  CONSTRAINT lab_test_ranges_low_below_high CHECK (low IS NULL OR high IS NULL OR low < high),
  -- A critical limit is never inside the normal range.
  CONSTRAINT lab_test_ranges_critical_low CHECK (
    critical_low IS NULL OR critical_low <= coalesce(low, high)
  ),
  CONSTRAINT lab_test_ranges_critical_high CHECK (
    critical_high IS NULL OR critical_high >= coalesce(high, low)
  ),
  CONSTRAINT lab_test_ranges_position UNIQUE (tenant_id, lab_test_id, position),
  CONSTRAINT lab_test_ranges_test FOREIGN KEY (tenant_id, lab_test_id)
    REFERENCES lab_tests (tenant_id, id)
);

-- The ranges of a test are replaced as a set, so the app role deletes here. No UPDATE.
SELECT enable_tenant_rls('lab_test_ranges', 'SELECT, INSERT, DELETE');

CREATE FUNCTION lab_test_ranges_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Only a numeric single test has reference ranges.
  IF NOT EXISTS (
    SELECT FROM lab_tests
    WHERE tenant_id = NEW.tenant_id AND id = NEW.lab_test_id
      AND kind = 'test' AND result_type = 'numeric'
  ) THEN
    RAISE EXCEPTION 'Only a numeric test has reference ranges' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_test_ranges_guard BEFORE INSERT ON lab_test_ranges
  FOR EACH ROW EXECUTE FUNCTION lab_test_ranges_guard();

CREATE FUNCTION lab_tests_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'A test''s hospital, identity, code and kind cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  -- A test that has reference ranges stays numeric until they are removed.
  IF NEW.result_type <> 'numeric' AND EXISTS (
    SELECT FROM lab_test_ranges WHERE tenant_id = NEW.tenant_id AND lab_test_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A test with reference ranges stays numeric' USING ERRCODE = '23514';
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

CREATE TRIGGER lab_tests_guard_update BEFORE UPDATE ON lab_tests
  FOR EACH ROW EXECUTE FUNCTION lab_tests_guard_update();
