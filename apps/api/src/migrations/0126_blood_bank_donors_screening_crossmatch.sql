-- Blood bank: donors, collections, screening, patient blood group and cross-match (#585, part A).
--
-- * A donor is not a patient: a small record (name, birth date, sex, group, phone) of its own.
-- * A collection is one donation by a donor and makes the units of it; insert-only.
-- * A screening is the infection tests of one unit, once; a reactive one discards the unit. A unit
--   cannot go from testing to available unless its screening cleared it, and only the screening
--   itself can set that (the guard allows the change from inside the screening's own trigger).
-- * The patient's blood group is an append-only table: the latest row is the current group.
-- * A cross-match is the check of one unit against one patient; reserving needs a compatible one
--   made in the last 72 hours.

CREATE TABLE blood_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  donor_number text NOT NULL CHECK (char_length(donor_number) BETWEEN 1 AND 20),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 100),
  date_of_birth date NOT NULL,
  sex text NOT NULL CHECK (sex IN ('female', 'male', 'other')),
  phone text CHECK (char_length(phone) BETWEEN 4 AND 20),
  blood_group text NOT NULL CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  -- Deferred for a while (until), or for good (permanent); the reason is kept either way.
  deferred_until timestamptz,
  deferred_permanent boolean NOT NULL DEFAULT false,
  deferral_reason text CHECK (char_length(deferral_reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_donors_deferral CHECK (
    (deferred_until IS NULL AND NOT deferred_permanent) = (deferral_reason IS NULL)
  ),
  CONSTRAINT blood_donors_number UNIQUE (tenant_id, donor_number),
  CONSTRAINT blood_donors_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX blood_donors_listing ON blood_donors (tenant_id, created_at DESC, id DESC);

CREATE FUNCTION blood_donors_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['deferred_until', 'deferred_permanent', 'deferral_reason', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['deferred_until', 'deferred_permanent', 'deferral_reason', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the deferral of a donor changes' USING ERRCODE = '42501';
  END IF;
  -- A permanent deferral is never lifted.
  IF OLD.deferred_permanent AND NOT NEW.deferred_permanent THEN
    RAISE EXCEPTION 'A permanent deferral is not lifted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_donors_touch BEFORE UPDATE ON blood_donors
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER blood_donors_guard BEFORE UPDATE ON blood_donors
  FOR EACH ROW EXECUTE FUNCTION blood_donors_guard();
SELECT enable_tenant_rls('blood_donors', 'SELECT, INSERT, UPDATE');

CREATE TABLE blood_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  donor_id uuid NOT NULL,
  collected_at timestamptz NOT NULL,
  volume_ml integer NOT NULL CHECK (volume_ml BETWEEN 50 AND 1000),
  collected_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_collections_donor FOREIGN KEY (tenant_id, donor_id)
    REFERENCES blood_donors (tenant_id, id),
  CONSTRAINT blood_collections_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX blood_collections_donor_idx ON blood_collections (tenant_id, donor_id, collected_at DESC);
SELECT enable_tenant_rls('blood_collections', 'SELECT, INSERT');

-- The unit remembers where it came from, and whether it was screened.
ALTER TABLE blood_units
  ADD COLUMN donor_id uuid,
  ADD COLUMN collection_id uuid,
  ADD COLUMN screening_status text NOT NULL DEFAULT 'pending'
    CHECK (screening_status IN ('pending', 'cleared', 'reactive')),
  ADD CONSTRAINT blood_units_donor_fk FOREIGN KEY (tenant_id, donor_id)
    REFERENCES blood_donors (tenant_id, id),
  ADD CONSTRAINT blood_units_collection_fk FOREIGN KEY (tenant_id, collection_id)
    REFERENCES blood_collections (tenant_id, id);
CREATE INDEX blood_units_donor_idx ON blood_units (tenant_id, donor_id) WHERE donor_id IS NOT NULL;

CREATE TABLE blood_screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  blood_unit_id uuid NOT NULL,
  hiv text NOT NULL CHECK (hiv IN ('negative', 'reactive')),
  hbv text NOT NULL CHECK (hbv IN ('negative', 'reactive')),
  hcv text NOT NULL CHECK (hcv IN ('negative', 'reactive')),
  syphilis text NOT NULL CHECK (syphilis IN ('negative', 'reactive')),
  malaria text NOT NULL CHECK (malaria IN ('negative', 'reactive')),
  outcome text GENERATED ALWAYS AS (
    CASE WHEN 'reactive' IN (hiv, hbv, hcv, syphilis, malaria) THEN 'reactive' ELSE 'cleared' END
  ) STORED,
  screened_by uuid NOT NULL,
  screened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_screenings_unit FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES blood_units (tenant_id, id),
  -- A unit is screened once.
  CONSTRAINT blood_screenings_once UNIQUE (tenant_id, blood_unit_id)
);
SELECT enable_tenant_rls('blood_screenings', 'SELECT, INSERT');

-- A screening is made while the unit is in testing, and sets the unit's screening status.
CREATE FUNCTION blood_screenings_apply() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM blood_units
    WHERE tenant_id = NEW.tenant_id AND id = NEW.blood_unit_id;
  IF current_status IS DISTINCT FROM 'testing' THEN
    RAISE EXCEPTION 'A unit is screened while it is in testing' USING ERRCODE = '23514';
  END IF;
  UPDATE blood_units SET screening_status = NEW.outcome
    WHERE tenant_id = NEW.tenant_id AND id = NEW.blood_unit_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_screenings_apply AFTER INSERT ON blood_screenings
  FOR EACH ROW EXECUTE FUNCTION blood_screenings_apply();

-- A patient's blood group: append-only, the latest row is current. A change from the group on
-- record needs a reason (the API asks for it).
CREATE TABLE patient_blood_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  blood_group text NOT NULL CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_blood_groups_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);
CREATE INDEX patient_blood_groups_patient_idx
  ON patient_blood_groups (tenant_id, patient_id, recorded_at DESC, id DESC);
SELECT enable_tenant_rls('patient_blood_groups', 'SELECT, INSERT');

-- A cross-match: one unit against one patient, good for 72 hours.
CREATE TABLE blood_crossmatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  blood_unit_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  result text NOT NULL CHECK (result IN ('compatible', 'incompatible')),
  performed_by uuid NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  CONSTRAINT blood_crossmatches_unit FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES blood_units (tenant_id, id),
  CONSTRAINT blood_crossmatches_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);
CREATE INDEX blood_crossmatches_unit_idx
  ON blood_crossmatches (tenant_id, blood_unit_id, patient_id, performed_at DESC);

CREATE FUNCTION blood_crossmatches_validity() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.valid_until := NEW.performed_at + interval '72 hours';
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_crossmatches_validity BEFORE INSERT ON blood_crossmatches
  FOR EACH ROW EXECUTE FUNCTION blood_crossmatches_validity();
SELECT enable_tenant_rls('blood_crossmatches', 'SELECT, INSERT');

-- A new unit starts unscreened.
CREATE FUNCTION blood_units_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.screening_status <> 'pending' THEN
    RAISE EXCEPTION 'A new blood unit is not yet screened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_units_insert_guard BEFORE INSERT ON blood_units
  FOR EACH ROW EXECUTE FUNCTION blood_units_insert_guard();

-- The unit guard: the old rules, plus screening and cross-match.
CREATE OR REPLACE FUNCTION blood_units_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'patient_id', 'screening_status', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'patient_id', 'screening_status', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the status of a blood unit changes' USING ERRCODE = '42501';
  END IF;
  -- Only a screening (its own trigger, one level down) says a unit is cleared.
  IF NEW.screening_status IS DISTINCT FROM OLD.screening_status AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Only a screening sets the screening status' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status AND NEW.screening_status IS NOT DISTINCT FROM OLD.screening_status THEN
    RAISE EXCEPTION 'A blood unit is not moved to the status it is in' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'collected' AND NEW.status IN ('testing', 'discarded'))
    OR (OLD.status = 'testing' AND NEW.status IN ('available', 'discarded'))
    OR (OLD.status = 'available' AND NEW.status IN ('reserved', 'discarded', 'expired'))
    OR (OLD.status = 'reserved' AND NEW.status IN ('available', 'issued', 'discarded', 'expired'))
    OR (OLD.status = 'issued' AND NEW.status IN ('transfused', 'discarded'))
  ) THEN
    RAISE EXCEPTION 'A blood unit cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'available' AND OLD.status = 'testing' AND NEW.screening_status <> 'cleared' THEN
    RAISE EXCEPTION 'A blood unit is not cleared by screening' USING ERRCODE = '23514';
  END IF;
  -- Blood past its date is not given out.
  IF NEW.status IN ('reserved', 'issued') AND NEW.status <> OLD.status AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'The blood unit has expired' USING ERRCODE = '23514';
  END IF;
  -- Reserving needs a compatible cross-match of this unit and patient, made in the last 72 hours.
  IF NEW.status = 'reserved' AND OLD.status <> 'reserved' AND COALESCE((
    SELECT c.result = 'compatible' AND c.valid_until > now() FROM blood_crossmatches c
    WHERE c.tenant_id = NEW.tenant_id AND c.blood_unit_id = NEW.id AND c.patient_id = NEW.patient_id
    ORDER BY c.performed_at DESC, c.id DESC LIMIT 1
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'A blood unit is reserved only after a valid cross-match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- A patient record that was merged into another takes no new rows here either (#557).
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON patient_blood_groups
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON blood_crossmatches
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
