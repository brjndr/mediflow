-- Appointments (BE-11): a patient booked with a doctor of the same hospital, from one instant to
-- another (UTC, as every timestamptz is). What the database itself guarantees:
--
-- * A doctor is never booked twice at overlapping times, and neither is a patient: exclusion
--   constraints on the scheduled appointments decide between bookings made at the same moment,
--   whatever the application checked before. Cancelled and no-show appointments free their time.
-- * An appointment refers to a patient and a doctor of its own hospital (references that carry
--   the hospital, since foreign keys are checked without row-level security).
-- * Only a scheduled appointment changes, and a final status (completed, cancelled, no-show)
--   never does. The rules that depend on the clock (too early, too late) are the API's, in the
--   same transaction as the change.

-- So appointments, and later encounters, can refer to a patient together with the hospital.
ALTER TABLE patients ADD CONSTRAINT patients_tenant_id_id UNIQUE (tenant_id, id);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  -- Why the patient is coming. Plain text, tidied by the API.
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  -- Why it was cancelled: on a cancelled appointment, and only there.
  cancel_reason text
    CHECK (cancel_reason IN ('patient_request', 'doctor_unavailable', 'hospital', 'duplicate', 'other')),
  cancel_note text CHECK (cancel_note IS NULL OR length(cancel_note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_times CHECK (ends_at > starts_at),
  CONSTRAINT appointments_cancellation CHECK (
    (status = 'cancelled') = (cancel_reason IS NOT NULL)
    AND (cancel_note IS NULL OR cancel_reason IS NOT NULL)
    AND (cancel_reason IS DISTINCT FROM 'other' OR cancel_note IS NOT NULL)
  ),
  CONSTRAINT appointments_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT appointments_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id),
  -- So encounters can refer to an appointment together with the hospital.
  CONSTRAINT appointments_tenant_id_id UNIQUE (tenant_id, id),
  -- No double booking of a doctor. Half-open ranges, so one appointment may end as the next starts.
  CONSTRAINT appointments_doctor_free EXCLUDE USING gist (
    tenant_id WITH =,
    doctor_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'scheduled'),
  -- A patient is in one place at a time, with any doctor.
  CONSTRAINT appointments_patient_free EXCLUDE USING gist (
    tenant_id WITH =,
    patient_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'scheduled')
);

-- The list: a range of days at the hospital, by start then id, filtered or not by doctor.
CREATE INDEX appointments_tenant_starts ON appointments (tenant_id, starts_at, id);
CREATE INDEX appointments_tenant_doctor_starts ON appointments (tenant_id, doctor_id, starts_at, id);
-- A patient's appointments (their screen, later).
CREATE INDEX appointments_tenant_patient ON appointments (tenant_id, patient_id, starts_at);

-- No DELETE: an appointment is cancelled, never removed.
SELECT enable_tenant_rls('appointments', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION appointments_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An appointment''s hospital, patient and booking details cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'A completed, cancelled or no-show appointment is final'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_guard_update BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_guard_update();
