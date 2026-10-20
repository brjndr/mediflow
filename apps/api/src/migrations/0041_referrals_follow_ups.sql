-- Referrals and follow-ups (#88): what a consultation asks to happen next.
--
-- * A referral sends the patient to a department of the hospital, or to one of its doctors, with a
--   reason and an urgency. It is never changed: one made by mistake is cancelled with a reason,
--   once, and kept.
-- * A follow-up is the day the patient should come back, and with whom. Booking it makes an
--   appointment, which it then names; one booked appointment per follow-up at a time. Whether it
--   is due, booked or attended is read from that appointment, so nothing here has to follow the
--   appointment's changes: a cancelled or no-show appointment leaves the follow-up due again.
--   One follow-up per encounter that is not cancelled.
-- * Both name their encounter and its patient together, as every child of an encounter does, and
--   their department, doctor and appointment with the hospital.

-- So a follow-up names an appointment of its own patient.
ALTER TABLE appointments ADD CONSTRAINT appointments_tenant_id_patient UNIQUE (tenant_id, id, patient_id);

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  department_id uuid NOT NULL,
  -- A doctor of that department, or any of its doctors.
  doctor_id uuid,
  urgency text NOT NULL CHECK (urgency IN ('routine', 'urgent')),
  -- Why the patient is referred. Plain text, tidied by the API.
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  referred_at timestamptz NOT NULL DEFAULT now(),
  referred_by uuid NOT NULL,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 200),
  CONSTRAINT referrals_cancellation CHECK (num_nulls(cancelled_at, cancelled_by, cancel_reason) IN (0, 3)),
  CONSTRAINT referrals_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT referrals_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT referrals_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id)
);

CREATE INDEX referrals_tenant_encounter ON referrals (tenant_id, encounter_id, referred_at, id);

SELECT enable_tenant_rls('referrals', 'SELECT, INSERT');
GRANT UPDATE (cancelled_at, cancelled_by, cancel_reason) ON referrals TO mediflow_app;

CREATE FUNCTION referrals_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) THEN
    RAISE EXCEPTION 'A referral is never changed; it is cancelled, once'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER referrals_guard_update BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_guard_update();

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- With whom the patient should come back.
  doctor_id uuid NOT NULL,
  -- A calendar day at the hospital, not an instant.
  due_on date NOT NULL,
  -- The same day as an instant (midnight UTC), only to sort and page by: the module's cursors
  -- carry an instant, and an index on the expression would not serve the cursor's comparison.
  due_at timestamptz GENERATED ALWAYS AS ((due_on::timestamp) AT TIME ZONE 'UTC') STORED,
  -- For whoever books it. Plain text, tidied by the API.
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  -- The appointment it was booked as, the latest one.
  appointment_id uuid,
  booked_at timestamptz,
  booked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT follow_ups_booking CHECK (num_nulls(appointment_id, booked_at, booked_by) IN (0, 3)),
  CONSTRAINT follow_ups_cancellation CHECK (num_nulls(cancelled_at, cancelled_by, cancel_reason) IN (0, 3)),
  CONSTRAINT follow_ups_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT follow_ups_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id),
  CONSTRAINT follow_ups_appointment FOREIGN KEY (tenant_id, appointment_id, patient_id)
    REFERENCES appointments (tenant_id, id, patient_id)
);

CREATE UNIQUE INDEX follow_ups_one_per_encounter ON follow_ups (tenant_id, encounter_id)
  WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX follow_ups_one_per_appointment ON follow_ups (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;
-- The due list (those not cancelled): by day, then id.
CREATE INDEX follow_ups_tenant_due ON follow_ups (tenant_id, due_at, id) WHERE cancelled_at IS NULL;
-- An encounter's follow-ups, cancelled ones included.
CREATE INDEX follow_ups_tenant_encounter ON follow_ups (tenant_id, encounter_id, due_at, id);

-- No DELETE: a follow-up is cancelled, never removed.
SELECT enable_tenant_rls('follow_ups', 'SELECT, INSERT');
GRANT UPDATE (appointment_id, booked_at, booked_by, cancelled_at, cancelled_by, cancel_reason, version)
  ON follow_ups TO mediflow_app;

CREATE FUNCTION follow_ups_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'A cancelled follow-up is final' USING ERRCODE = '42501';
  END IF;
  -- due_at is generated after this trigger runs (null in NEW here), from due_on, which is compared.
  IF (to_jsonb(NEW) - ARRAY['appointment_id', 'booked_at', 'booked_by', 'cancelled_at',
                            'cancelled_by', 'cancel_reason', 'version', 'due_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['appointment_id', 'booked_at', 'booked_by',
                                             'cancelled_at', 'cancelled_by', 'cancel_reason',
                                             'version', 'due_at']) THEN
    RAISE EXCEPTION 'A follow-up''s encounter, doctor and day cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_ups_guard_update BEFORE UPDATE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION follow_ups_guard_update();
