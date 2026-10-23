-- The laboratory (BE-19): the samples of lab orders and their results. What the database itself
-- guarantees:
--
-- * An order has at most one sample that is not rejected; a recollection is a new sample.
-- * Accession ids are unique per hospital, numbered per hospital day by one counter row per day,
--   so two collections at the same moment wait for each other instead of colliding.
-- * A sample moves only collected -> received, collected -> rejected and received -> rejected,
--   and is never rejected once it has a result. What it is of, and who collected it, never change.
-- * Results are append-only: a result is entered, then verified once; a correction is a new
--   result that names the one it replaces, with a reason, and a result is replaced once.
-- * Every reference carries the hospital, since foreign keys are checked without row-level
--   security; a sample names its order, encounter, patient and test together, and a result its
--   sample, order, encounter and patient.

-- So a sample can name its order with the encounter, patient and test together.
ALTER TABLE orders
  ADD CONSTRAINT orders_tenant_id_lab UNIQUE (tenant_id, id, encounter_id, patient_id, lab_test_id);

-- The laboratory's worklist: the hospital's lab orders still open, oldest first.
CREATE INDEX orders_tenant_lab_open ON orders (tenant_id, placed_at, id)
  WHERE type = 'lab' AND status NOT IN ('cancelled', 'completed');

CREATE TABLE lab_accession_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- The calendar day at the hospital.
  day date NOT NULL,
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, day)
);

SELECT enable_tenant_rls('lab_accession_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE lab_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  -- Copied from the order, so results and the audit reach them without the clinical tables.
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  lab_test_id uuid NOT NULL,
  -- YYMMDD-NNNN, the hospital day and its number; more digits past 9999 in a day.
  accession_id text NOT NULL CHECK (accession_id ~ '^[0-9]{6}-[0-9]{4,6}$'),
  -- The test's sample and container as the catalog had them when collected, as on the label.
  sample_type text NOT NULL CHECK (sample_type IN (
    'blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'sputum', 'csf', 'tissue', 'other'
  )),
  container text CHECK (container IS NULL OR length(container) BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'collected' CHECK (status IN ('collected', 'received', 'rejected')),
  collected_at timestamptz NOT NULL DEFAULT now(),
  collected_by uuid NOT NULL,
  received_at timestamptz,
  received_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  reject_reason text CHECK (reject_reason IN (
    'haemolysed', 'clotted', 'insufficient', 'mislabelled', 'wrong_container', 'contaminated',
    'other'
  )),
  -- Plain text, tidied by the API. Required with the reason `other`.
  reject_note text CHECK (reject_note IS NULL OR length(reject_note) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT lab_samples_received CHECK (
    (received_at IS NULL) = (received_by IS NULL)
    AND (status <> 'received' OR received_at IS NOT NULL)
  ),
  CONSTRAINT lab_samples_rejected CHECK (
    (status = 'rejected') = (rejected_at IS NOT NULL)
    AND (rejected_at IS NULL) = (rejected_by IS NULL)
    AND (rejected_at IS NULL) = (reject_reason IS NULL)
  ),
  CONSTRAINT lab_samples_reject_note CHECK (
    (reject_reason IS NOT NULL OR reject_note IS NULL)
    AND (reject_reason IS DISTINCT FROM 'other' OR reject_note IS NOT NULL)
  ),
  CONSTRAINT lab_samples_order FOREIGN KEY (tenant_id, order_id, encounter_id, patient_id, lab_test_id)
    REFERENCES orders (tenant_id, id, encounter_id, patient_id, lab_test_id),
  CONSTRAINT lab_samples_accession_taken UNIQUE (tenant_id, accession_id),
  -- So results can name a sample together with its order, encounter and patient.
  CONSTRAINT lab_samples_tenant_id_id UNIQUE (tenant_id, id, order_id, encounter_id, patient_id)
);

-- One sample not rejected per order.
CREATE UNIQUE INDEX lab_samples_one_standing ON lab_samples (tenant_id, order_id)
  WHERE status <> 'rejected';
-- The samples of an order, newest last.
CREATE INDEX lab_samples_tenant_order ON lab_samples (tenant_id, order_id, collected_at);

-- No DELETE: a rejected sample stays, with its reason.
SELECT enable_tenant_rls('lab_samples', 'SELECT, INSERT, UPDATE');

CREATE TABLE lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  sample_id uuid NOT NULL,
  order_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- What was measured: the test ordered, or one test of the panel ordered.
  lab_test_id uuid NOT NULL,
  -- The test as it read when the result was entered, so the report reads the same later.
  test_code text NOT NULL CHECK (length(test_code) BETWEEN 1 AND 30),
  test_name text NOT NULL CHECK (length(test_name) BETWEEN 1 AND 150),
  result_type text NOT NULL CHECK (result_type IN ('numeric', 'text')),
  -- A number as it was typed, its decimals kept, or text.
  value_number numeric CHECK (value_number > -1e9 AND value_number < 1e9),
  value_text text CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  unit text CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 30),
  -- The reference range the number was read against, as it was: the ranges of a test are
  -- replaced as a set, so they are copied, never referred to. None when no range applied.
  range_low double precision,
  range_high double precision,
  range_critical_low double precision,
  range_critical_high double precision,
  range_note text CHECK (range_note IS NULL OR length(range_note) BETWEEN 1 AND 150),
  flag text CHECK (flag IN ('normal', 'low', 'high', 'critical_low', 'critical_high')),
  comment text CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'entered' CHECK (status IN ('entered', 'verified')),
  entered_at timestamptz NOT NULL DEFAULT now(),
  entered_by uuid NOT NULL,
  verified_at timestamptz,
  verified_by uuid,
  -- A correction names the result it replaces, of the same sample and test, and says why.
  amends_id uuid,
  amendment_reason text
    CHECK (amendment_reason IS NULL OR length(amendment_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT lab_results_value CHECK (
    CASE result_type
      WHEN 'numeric' THEN value_number IS NOT NULL AND value_text IS NULL
      WHEN 'text' THEN value_text IS NOT NULL AND value_number IS NULL
        AND unit IS NULL AND flag IS NULL
        AND num_nonnulls(range_low, range_high, range_critical_low, range_critical_high, range_note) = 0
    END
  ),
  CONSTRAINT lab_results_flag CHECK ((flag IS NULL) = (range_low IS NULL AND range_high IS NULL)),
  CONSTRAINT lab_results_verified CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
    AND (verified_at IS NULL) = (verified_by IS NULL)
  ),
  CONSTRAINT lab_results_amendment CHECK ((amends_id IS NULL) = (amendment_reason IS NULL)),
  CONSTRAINT lab_results_sample FOREIGN KEY (tenant_id, sample_id, order_id, encounter_id, patient_id)
    REFERENCES lab_samples (tenant_id, id, order_id, encounter_id, patient_id),
  CONSTRAINT lab_results_test FOREIGN KEY (tenant_id, lab_test_id)
    REFERENCES lab_tests (tenant_id, id),
  CONSTRAINT lab_results_tenant_id_id UNIQUE (tenant_id, id, sample_id, lab_test_id),
  CONSTRAINT lab_results_amends FOREIGN KEY (tenant_id, amends_id, sample_id, lab_test_id)
    REFERENCES lab_results (tenant_id, id, sample_id, lab_test_id)
);

-- A result is replaced once, so the history of a test is one line.
CREATE UNIQUE INDEX lab_results_amended_once ON lab_results (tenant_id, amends_id)
  WHERE amends_id IS NOT NULL;
-- One first result per test of a sample: later ones are corrections.
CREATE UNIQUE INDEX lab_results_one_first ON lab_results (tenant_id, sample_id, lab_test_id)
  WHERE amends_id IS NULL;
CREATE INDEX lab_results_tenant_sample ON lab_results (tenant_id, sample_id, entered_at, id);

-- No DELETE: results are corrected by new ones, never removed.
SELECT enable_tenant_rls('lab_results', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION lab_samples_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id
     OR NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.lab_test_id <> OLD.lab_test_id OR NEW.accession_id <> OLD.accession_id
     OR NEW.sample_type <> OLD.sample_type OR NEW.container IS DISTINCT FROM OLD.container
     OR NEW.collected_at <> OLD.collected_at OR NEW.collected_by <> OLD.collected_by THEN
    RAISE EXCEPTION 'What a sample is of, and its collection, never change'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.received_at IS NOT NULL AND (NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.received_by IS DISTINCT FROM OLD.received_by) THEN
    RAISE EXCEPTION 'A sample is received once' USING ERRCODE = '42501';
  END IF;
  IF NOT (
       (OLD.status = 'collected' AND NEW.status IN ('received', 'rejected'))
    OR (OLD.status = 'received' AND NEW.status = 'rejected')
  ) THEN
    RAISE EXCEPTION 'A sample does not move from % to %', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'rejected' AND EXISTS (
    SELECT FROM lab_results WHERE tenant_id = NEW.tenant_id AND sample_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A sample with results is not rejected' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_samples_guard_update BEFORE UPDATE ON lab_samples
  FOR EACH ROW EXECUTE FUNCTION lab_samples_guard_update();

-- A result is verified once, and nothing else of it ever changes.
CREATE FUNCTION lab_results_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'entered' OR NEW.status <> 'verified' OR
     (to_jsonb(NEW) - ARRAY['status', 'verified_at', 'verified_by', 'version'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'verified_at', 'verified_by', 'version']) THEN
    RAISE EXCEPTION 'A result is only ever verified, once' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_results_guard_update BEFORE UPDATE ON lab_results
  FOR EACH ROW EXECUTE FUNCTION lab_results_guard_update();

-- A result is entered for a sample the laboratory has received, never for one collected or
-- rejected.
CREATE FUNCTION lab_results_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM lab_samples
  WHERE tenant_id = NEW.tenant_id AND id = NEW.sample_id AND status = 'received'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Results are entered for a received sample' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_results_guard_insert BEFORE INSERT ON lab_results
  FOR EACH ROW EXECUTE FUNCTION lab_results_guard_insert();
