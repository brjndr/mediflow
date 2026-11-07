-- Admission, discharge and transfer (BE-23): the admissions of inpatients and the history of the
-- beds each was in. What the database itself guarantees:
--
-- * A patient has at most one admission not yet discharged, and an admission has its own
--   inpatient encounter (the one every clinical and billing record of the stay attaches to).
-- * A bed holds one patient at a time, and an admission is in one bed at a time: exclusion
--   constraints over the time each assignment lasted, so two requests that both pass the checks
--   of the code cannot both succeed.
-- * An assignment never changes except to be released, once, with who, when and why. An
--   admission never changes except to be discharged, once, or to count a change of its bed (the
--   version moves). Nothing is deleted.
-- * An assignment keeps the category and the service of its bed as they were when the patient
--   was given it, so a later change of the bed's category never reprices a stay (wards, 0024).

CREATE TABLE admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  admitting_doctor_id uuid NOT NULL,
  department_id uuid NOT NULL,
  admission_type text NOT NULL CHECK (admission_type IN ('planned', 'emergency', 'transfer_in')),
  status text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'discharged')),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  admitted_by uuid NOT NULL,
  discharged_at timestamptz,
  discharged_by uuid,
  discharge_type text
    CHECK (discharge_type IN ('routine', 'against_advice', 'referred', 'absconded', 'deceased')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admissions_discharged CHECK (
    (status = 'discharged') = (discharged_at IS NOT NULL)
    AND (discharged_at IS NULL) = (discharged_by IS NULL)
    AND (discharged_at IS NULL) = (discharge_type IS NULL)
  ),
  CONSTRAINT admissions_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT admissions_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT admissions_doctor FOREIGN KEY (tenant_id, admitting_doctor_id)
    REFERENCES doctors (tenant_id, id),
  CONSTRAINT admissions_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT admissions_tenant_id_id UNIQUE (tenant_id, id),
  -- So an assignment names the admission and its patient together.
  CONSTRAINT admissions_tenant_id_patient UNIQUE (tenant_id, id, patient_id),
  CONSTRAINT admissions_one_per_encounter UNIQUE (tenant_id, encounter_id)
);

CREATE UNIQUE INDEX admissions_one_active ON admissions (tenant_id, patient_id)
  WHERE status = 'admitted';
CREATE INDEX admissions_tenant_status ON admissions (tenant_id, status, admitted_at DESC, id DESC);
CREATE INDEX admissions_tenant_patient ON admissions (tenant_id, patient_id, admitted_at DESC);

SELECT enable_tenant_rls('admissions', 'SELECT, INSERT, UPDATE');

CREATE TABLE bed_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  bed_id uuid NOT NULL,
  ward_id uuid NOT NULL,
  -- The bed's category and its bed-day service when the patient was given the bed.
  bed_category_id uuid NOT NULL,
  service_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL,
  released_at timestamptz,
  released_by uuid,
  release_reason text CHECK (release_reason IN ('transfer', 'discharge')),
  CONSTRAINT bed_assignments_released CHECK (
    (released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL)
  ),
  CONSTRAINT bed_assignments_in_order CHECK (released_at IS NULL OR released_at >= assigned_at),
  CONSTRAINT bed_assignments_admission FOREIGN KEY (tenant_id, admission_id, patient_id)
    REFERENCES admissions (tenant_id, id, patient_id),
  CONSTRAINT bed_assignments_bed FOREIGN KEY (tenant_id, bed_id) REFERENCES beds (tenant_id, id),
  CONSTRAINT bed_assignments_ward FOREIGN KEY (tenant_id, ward_id) REFERENCES wards (tenant_id, id),
  CONSTRAINT bed_assignments_category FOREIGN KEY (tenant_id, bed_category_id)
    REFERENCES bed_categories (tenant_id, id),
  CONSTRAINT bed_assignments_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  -- One patient in a bed at a time, and an admission in one bed at a time. An assignment lasts
  -- from assigned_at to released_at, open-ended until released.
  CONSTRAINT bed_assignments_one_patient_per_bed EXCLUDE USING gist (
    tenant_id WITH =, bed_id WITH =, tstzrange(assigned_at, released_at, '[)') WITH &&
  ),
  CONSTRAINT bed_assignments_one_bed_per_admission EXCLUDE USING gist (
    tenant_id WITH =, admission_id WITH =, tstzrange(assigned_at, released_at, '[)') WITH &&
  ),
  CONSTRAINT bed_assignments_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX bed_assignments_tenant_admission ON bed_assignments (tenant_id, admission_id, assigned_at);
-- The bed board reads who is in each bed now.
CREATE INDEX bed_assignments_open ON bed_assignments (tenant_id, ward_id, bed_id)
  WHERE released_at IS NULL;

SELECT enable_tenant_rls('bed_assignments', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION admissions_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'admitted'
     OR (to_jsonb(NEW) - ARRAY['status', 'discharged_at', 'discharged_by', 'discharge_type', 'version', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'discharged_at', 'discharged_by', 'discharge_type', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'An admission is only discharged, once' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER admissions_guard_update BEFORE UPDATE ON admissions
  FOR EACH ROW EXECUTE FUNCTION admissions_guard_update();

CREATE FUNCTION bed_assignments_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.released_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by', 'release_reason'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['released_at', 'released_by', 'release_reason']) THEN
    RAISE EXCEPTION 'A bed assignment is only released, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bed_assignments_guard_update BEFORE UPDATE ON bed_assignments
  FOR EACH ROW EXECUTE FUNCTION bed_assignments_guard_update();
