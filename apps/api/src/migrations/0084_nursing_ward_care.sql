-- Nursing and ward care (BE-24, #163): what is recorded about an admitted patient on the ward.
-- What the database itself guarantees:
--
-- * Every row names an admission together with its inpatient encounter and patient, so a row
--   cannot be of another stay or of another patient than the stay's. A row is only written while
--   the admission is `admitted` and its encounter is an open inpatient one (a trigger, whoever
--   the writer is).
-- * Ward vital signs, administrations on the medication chart and the versions of a progress note
--   are append-only: the app role may only insert and read them, and a trigger refuses UPDATE,
--   DELETE and TRUNCATE to everyone, the owner included. A correction is a new row that names the
--   one it corrects, with a reason, and a row is corrected once.
-- * An administration names a medication order of the same encounter and patient, and a slot
--   (the order and the time it was due) has one entry; a correction keeps the order and the slot.
-- * A progress note is the one editable table: only its text moves, each change bumps `version`
--   and its text is kept in `progress_note_versions`.
-- * A request for ward stock names the indent it made and the admission it was for.

-- So a ward record names the admission, the encounter and the patient together.
ALTER TABLE admissions ADD CONSTRAINT admissions_tenant_stay
  UNIQUE (tenant_id, id, encounter_id, patient_id);

CREATE FUNCTION nursing_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'A ward record is never changed or removed' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION nursing_no_truncate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'Ward records are never emptied' USING ERRCODE = '42501';
END;
$$;

-- Writes only while the stay is open: the admission is admitted and its encounter an open
-- inpatient one. Runs as the writer, so row-level security limits what it sees to the hospital.
CREATE FUNCTION nursing_open_stay() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM admissions a
    JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.admission_id
      AND a.encounter_id = NEW.encounter_id
      AND a.status = 'admitted' AND e.type = 'ipd' AND e.status = 'open'
  ) THEN
    RAISE EXCEPTION 'The stay is not open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- --- vital signs -------------------------------------------------------------------------------

CREATE TABLE ward_vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- When the measurements were taken, and when they were written down.
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  systolic smallint CHECK (systolic BETWEEN 40 AND 300),
  diastolic smallint CHECK (diastolic BETWEEN 20 AND 200),
  pulse smallint CHECK (pulse BETWEEN 20 AND 300),
  temperature numeric(3, 1) CHECK (temperature BETWEEN 25 AND 45),
  spo2 smallint CHECK (spo2 BETWEEN 50 AND 100),
  weight numeric(4, 1) CHECK (weight BETWEEN 0.3 AND 400),
  height numeric(4, 1) CHECK (height BETWEEN 20 AND 250),
  corrects_id uuid,
  correction_reason text CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 200),
  CONSTRAINT ward_vitals_something CHECK (
    num_nonnulls(systolic, diastolic, pulse, temperature, spo2, weight, height) > 0
  ),
  CONSTRAINT ward_vitals_pressure CHECK (
    (systolic IS NULL) = (diastolic IS NULL) AND (systolic IS NULL OR diastolic < systolic)
  ),
  CONSTRAINT ward_vitals_correction CHECK ((corrects_id IS NULL) = (correction_reason IS NULL)),
  CONSTRAINT ward_vitals_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT ward_vitals_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT ward_vitals_tenant_id_admission UNIQUE (tenant_id, id, admission_id),
  -- A correction is of a reading of the same stay.
  CONSTRAINT ward_vitals_corrects FOREIGN KEY (tenant_id, corrects_id, admission_id)
    REFERENCES ward_vitals (tenant_id, id, admission_id)
);

CREATE INDEX ward_vitals_tenant_admission ON ward_vitals (tenant_id, admission_id, observed_at DESC, id DESC);
CREATE UNIQUE INDEX ward_vitals_corrected_once ON ward_vitals (tenant_id, corrects_id)
  WHERE corrects_id IS NOT NULL;

SELECT enable_tenant_rls('ward_vitals', 'SELECT, INSERT');

-- --- the medication chart ----------------------------------------------------------------------

CREATE TABLE mar_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  order_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  -- The time the dose was due: with the order, the slot this entry answers.
  scheduled_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('given', 'withheld', 'refused', 'missed')),
  dose_given text CHECK (dose_given IS NULL OR length(dose_given) BETWEEN 1 AND 50),
  route text CHECK (route IN (
    'oral', 'sublingual', 'topical', 'inhaled', 'nasal', 'eye', 'ear', 'rectal', 'vaginal',
    'intramuscular', 'intravenous', 'subcutaneous', 'other'
  )),
  -- Plain text, tidied by the API. Why it was not given, why an extra dose was, why this corrects.
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  administered_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  -- A second nurse who saw it given (a high-risk medicine). Whether one is needed is not enforced yet.
  witness_by uuid,
  corrects_id uuid,
  CONSTRAINT mar_entries_given CHECK (
    (outcome = 'given') = (administered_at IS NOT NULL AND dose_given IS NOT NULL AND route IS NOT NULL)
  ),
  CONSTRAINT mar_entries_reason CHECK (
    (outcome = 'given' AND corrects_id IS NULL) OR reason IS NOT NULL
  ),
  CONSTRAINT mar_entries_witness CHECK (witness_by IS NULL OR witness_by <> recorded_by),
  CONSTRAINT mar_entries_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT mar_entries_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  -- The order is of this encounter and patient, and the drug is the one ordered.
  CONSTRAINT mar_entries_order FOREIGN KEY (tenant_id, order_id, encounter_id, patient_id, drug_id)
    REFERENCES orders (tenant_id, id, encounter_id, patient_id, drug_id),
  CONSTRAINT mar_entries_tenant_id_slot UNIQUE (tenant_id, id, order_id, scheduled_at),
  CONSTRAINT mar_entries_tenant_id_admission UNIQUE (tenant_id, id, admission_id),
  -- A correction is of an entry of the same order and slot.
  CONSTRAINT mar_entries_corrects FOREIGN KEY (tenant_id, corrects_id, order_id, scheduled_at)
    REFERENCES mar_entries (tenant_id, id, order_id, scheduled_at)
);

CREATE INDEX mar_entries_tenant_admission ON mar_entries (tenant_id, admission_id, scheduled_at DESC, id DESC);
CREATE INDEX mar_entries_tenant_order ON mar_entries (tenant_id, order_id, scheduled_at);
-- One entry for each slot of an order; a correction is the way to change it.
CREATE UNIQUE INDEX mar_entries_slot_once ON mar_entries (tenant_id, order_id, scheduled_at)
  WHERE corrects_id IS NULL;
CREATE UNIQUE INDEX mar_entries_corrected_once ON mar_entries (tenant_id, corrects_id)
  WHERE corrects_id IS NOT NULL;

SELECT enable_tenant_rls('mar_entries', 'SELECT, INSERT');

-- --- progress notes ----------------------------------------------------------------------------

CREATE TABLE progress_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('nursing', 'handover', 'observation')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT progress_notes_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT progress_notes_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT progress_notes_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT progress_notes_tenant_id_admission UNIQUE (tenant_id, id, admission_id)
);

CREATE INDEX progress_notes_tenant_admission ON progress_notes (tenant_id, admission_id, created_at DESC, id DESC);

SELECT enable_tenant_rls('progress_notes', 'SELECT, INSERT, UPDATE');

-- Only the text moves, while the stay is open; each change is counted by the version. Never removed.
CREATE FUNCTION progress_notes_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  moved text[] := ARRAY['body', 'updated_at', 'updated_by', 'version'];
BEGIN
  IF (to_jsonb(NEW) - moved) IS DISTINCT FROM (to_jsonb(OLD) - moved) THEN
    RAISE EXCEPTION 'Only the text of a progress note changes' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM admissions a
    JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
    WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.admission_id
      AND a.status = 'admitted' AND e.type = 'ipd' AND e.status = 'open'
  ) THEN
    RAISE EXCEPTION 'The stay is not open' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER progress_notes_guard_update BEFORE UPDATE ON progress_notes
  FOR EACH ROW EXECUTE FUNCTION progress_notes_guard_update();
CREATE TRIGGER progress_notes_never_deleted BEFORE DELETE ON progress_notes
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();

CREATE TABLE progress_note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  note_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  edited_at timestamptz NOT NULL DEFAULT now(),
  edited_by uuid NOT NULL,
  CONSTRAINT progress_note_versions_note FOREIGN KEY (tenant_id, note_id)
    REFERENCES progress_notes (tenant_id, id),
  CONSTRAINT progress_note_versions_once UNIQUE (tenant_id, note_id, version)
);

SELECT enable_tenant_rls('progress_note_versions', 'SELECT, INSERT');

-- --- ward stock requests -----------------------------------------------------------------------

CREATE TABLE ward_stock_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  indent_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- The place that asked: the ward's own stock.
  place_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ward_stock_requests_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT ward_stock_requests_indent FOREIGN KEY (tenant_id, indent_id)
    REFERENCES stock_indents (tenant_id, id),
  CONSTRAINT ward_stock_requests_place FOREIGN KEY (tenant_id, place_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT ward_stock_requests_indent_once UNIQUE (tenant_id, indent_id)
);

CREATE INDEX ward_stock_requests_tenant_admission ON ward_stock_requests (tenant_id, admission_id, requested_at DESC);

SELECT enable_tenant_rls('ward_stock_requests', 'SELECT, INSERT');

-- --- the guards --------------------------------------------------------------------------------

CREATE TRIGGER ward_vitals_open_stay BEFORE INSERT ON ward_vitals
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();
CREATE TRIGGER mar_entries_open_stay BEFORE INSERT ON mar_entries
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();
CREATE TRIGGER progress_notes_open_stay BEFORE INSERT ON progress_notes
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();
CREATE TRIGGER ward_stock_requests_open_stay BEFORE INSERT ON ward_stock_requests
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();

CREATE TRIGGER ward_vitals_never_change BEFORE UPDATE OR DELETE ON ward_vitals
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER mar_entries_never_change BEFORE UPDATE OR DELETE ON mar_entries
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER progress_note_versions_never_change BEFORE UPDATE OR DELETE ON progress_note_versions
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER ward_stock_requests_never_change BEFORE UPDATE OR DELETE ON ward_stock_requests
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();

CREATE TRIGGER ward_vitals_no_truncate BEFORE TRUNCATE ON ward_vitals
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
CREATE TRIGGER mar_entries_no_truncate BEFORE TRUNCATE ON mar_entries
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
CREATE TRIGGER progress_notes_no_truncate BEFORE TRUNCATE ON progress_notes
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
CREATE TRIGGER progress_note_versions_no_truncate BEFORE TRUNCATE ON progress_note_versions
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
CREATE TRIGGER ward_stock_requests_no_truncate BEFORE TRUNCATE ON ward_stock_requests
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
