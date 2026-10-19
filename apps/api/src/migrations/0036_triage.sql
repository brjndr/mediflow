-- Triage (BE-18): vital signs, the chief complaint and allergies, taken before the consultation.
--
-- * A reading is append-only. A correction is a new reading that names the one it corrects, with
--   a reason, and a reading is corrected once, so the history never forks. Nothing of a reading
--   changes afterwards except `encounter_id`, set once from empty by the triage module when the
--   OPD encounter of the reading's token opens (M7).
-- * A patient's allergies are one list, replaced whole from the version the edit started from.
--   No row means never asked.
-- * The normal ranges are the hospital's own, for adults. A hospital with none uses the API's
--   built-in ones; editing them is #378.

CREATE TABLE vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  -- The queue token the reading was taken for; a correction carries the corrected one's.
  queue_token_id uuid,
  -- The OPD encounter, once M7 opens one. No reference yet: the table does not exist.
  encounter_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  systolic smallint CHECK (systolic BETWEEN 40 AND 300),
  diastolic smallint CHECK (diastolic BETWEEN 20 AND 200),
  pulse smallint CHECK (pulse BETWEEN 20 AND 300),
  -- Degrees Celsius, kilograms and centimetres, to one decimal.
  temperature numeric(3, 1) CHECK (temperature BETWEEN 25 AND 45),
  spo2 smallint CHECK (spo2 BETWEEN 50 AND 100),
  weight numeric(4, 1) CHECK (weight BETWEEN 0.3 AND 400),
  height numeric(4, 1) CHECK (height BETWEEN 20 AND 250),
  -- Plain text, tidied by the API.
  chief_complaint text CHECK (chief_complaint IS NULL OR length(chief_complaint) BETWEEN 1 AND 500),
  corrects_id uuid,
  correction_reason text
    CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 200),
  CONSTRAINT vitals_blood_pressure CHECK (
    (systolic IS NULL) = (diastolic IS NULL) AND (systolic IS NULL OR diastolic < systolic)
  ),
  CONSTRAINT vitals_something CHECK (
    num_nonnulls(systolic, pulse, temperature, spo2, weight, height, chief_complaint) > 0
  ),
  CONSTRAINT vitals_correction CHECK ((corrects_id IS NULL) = (correction_reason IS NULL)),
  CONSTRAINT vitals_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT vitals_token FOREIGN KEY (tenant_id, queue_token_id)
    REFERENCES queue_tokens (tenant_id, id),
  CONSTRAINT vitals_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT vitals_corrects FOREIGN KEY (tenant_id, corrects_id)
    REFERENCES vitals (tenant_id, id)
);

-- A reading is corrected once: a later correction corrects the correction.
CREATE UNIQUE INDEX vitals_corrected_once ON vitals (tenant_id, corrects_id)
  WHERE corrects_id IS NOT NULL;
-- A patient's readings, newest first.
CREATE INDEX vitals_tenant_patient ON vitals (tenant_id, patient_id, recorded_at DESC, id DESC);
-- The readings of a token, and the ones to attach to its encounter.
CREATE INDEX vitals_tenant_token ON vitals (tenant_id, queue_token_id) WHERE queue_token_id IS NOT NULL;

SELECT enable_tenant_rls('vitals', 'SELECT, INSERT');
GRANT UPDATE (encounter_id) ON vitals TO mediflow_app;

CREATE FUNCTION vitals_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.encounter_id IS NOT NULL OR NEW.encounter_id IS NULL
     OR (to_jsonb(NEW) - 'encounter_id') IS DISTINCT FROM (to_jsonb(OLD) - 'encounter_id') THEN
    RAISE EXCEPTION 'A reading is never changed; only its encounter is set, once'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vitals_guard_update BEFORE UPDATE ON vitals
  FOR EACH ROW EXECUTE FUNCTION vitals_guard_update();

CREATE TABLE allergy_lists (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  -- `none`: asked, no known allergies. `listed`: the items. No row: never asked.
  status text NOT NULL CHECK (status IN ('none', 'listed')),
  -- [{ substance, reaction?, severity }], checked and tidied by the API.
  items jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, patient_id),
  CONSTRAINT allergy_lists_items CHECK (
    jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) <= 50
    AND (status = 'none') = (jsonb_array_length(items) = 0)
  ),
  CONSTRAINT allergy_lists_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);

SELECT enable_tenant_rls('allergy_lists', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION allergy_lists_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id THEN
    RAISE EXCEPTION 'An allergy list''s hospital and patient cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER allergy_lists_guard_update BEFORE UPDATE ON allergy_lists
  FOR EACH ROW EXECUTE FUNCTION allergy_lists_guard_update();

CREATE TABLE vital_ranges (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  measure text NOT NULL CHECK (measure IN ('systolic', 'diastolic', 'pulse', 'temperature', 'spo2')),
  -- A limit that is absent is not checked.
  low numeric(5, 1),
  high numeric(5, 1),
  PRIMARY KEY (tenant_id, measure),
  CONSTRAINT vital_ranges_limits CHECK (num_nonnulls(low, high) > 0 AND (low IS NULL OR high IS NULL OR low < high))
);

-- Read-only for the app until the ranges can be edited (#378): seeded per hospital.
SELECT enable_tenant_rls('vital_ranges', 'SELECT');
