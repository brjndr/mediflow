-- Doctors (BE-10): a member of staff's profile as a doctor, in one department, and their regular
-- weekly working hours, which scheduling reads. No patient data.

CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL,
  department_id uuid NOT NULL,
  specialization text NOT NULL
    CHECK (specialization = btrim(specialization) AND length(specialization) BETWEEN 1 AND 100),
  -- The medical council registration number.
  registration_number text
    CHECK (registration_number IS NULL OR length(registration_number) BETWEEN 1 AND 50),
  -- The usual length of one appointment.
  consultation_minutes integer NOT NULL CHECK (consultation_minutes BETWEEN 5 AND 120),
  -- False once the doctor no longer practises here: kept on old records, not offered for new.
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The working hours are changed on their own, by other people at other times than the profile,
  -- so they are counted on their own.
  hours_version integer NOT NULL DEFAULT 1 CHECK (hours_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One profile per person per hospital.
  CONSTRAINT doctors_one_profile UNIQUE (tenant_id, user_id),
  -- A doctor is a member of this hospital, in a department of this hospital. Both references
  -- carry the hospital: foreign keys are checked without row-level security, so a reference by
  -- id alone could point into another hospital.
  CONSTRAINT doctors_member FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT doctors_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  -- So appointments and encounters can refer to a doctor together with the hospital.
  CONSTRAINT doctors_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX doctors_tenant_department ON doctors (tenant_id, department_id, active);

-- No DELETE for the app role: a profile is made inactive, never removed.
SELECT enable_tenant_rls('doctors', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION doctors_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A doctor profile''s hospital, identity and person cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  -- Each of the two versions is the database's to count, and goes up only when what it stands
  -- for was changed: the profile, or the working hours.
  IF (NEW.department_id, NEW.specialization, NEW.registration_number, NEW.consultation_minutes,
      NEW.active)
     IS DISTINCT FROM
     (OLD.department_id, OLD.specialization, OLD.registration_number, OLD.consultation_minutes,
      OLD.active) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  IF NEW.hours_version IS DISTINCT FROM OLD.hours_version THEN
    NEW.hours_version := OLD.hours_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER doctors_guard_update BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_guard_update();

-- Regular weekly hours: any number of sessions a day, in the hospital's own time. A day with no
-- session is a day off.
CREATE TABLE doctor_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  doctor_id uuid NOT NULL,
  -- 1 is Monday, 7 is Sunday.
  day smallint NOT NULL CHECK (day BETWEEN 1 AND 7),
  -- Minutes after midnight at the hospital.
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1439),
  CHECK (end_minute > start_minute),
  CONSTRAINT doctor_hours_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id) ON DELETE CASCADE,
  -- Two sessions of one doctor on one day never overlap, whatever the application checks.
  CONSTRAINT doctor_hours_no_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    day WITH =,
    int4range(start_minute, end_minute) WITH &&
  )
);

CREATE INDEX doctor_hours_tenant_doctor ON doctor_hours (tenant_id, doctor_id, day, start_minute);

-- Replacing a doctor's hours deletes the old sessions, so the app role may delete here.
SELECT enable_tenant_rls('doctor_hours');
