-- The medical records desk (#570, MR-04): coding of text diagnoses, record assignments and the
-- log of requests for copies of a record. What is missing from a closed record is worked out from
-- the encounter when asked, never stored.

-- So a coding names the diagnosis and its hospital together.
ALTER TABLE encounter_diagnoses
  ADD CONSTRAINT encounter_diagnoses_tenant_id_id UNIQUE (tenant_id, id);

-- Closed encounters of a hospital, oldest first: the incomplete records list reads them in order.
CREATE INDEX encounters_closed_by_end ON encounters (tenant_id, ended_at, id)
  WHERE status = 'closed';

-- The code the desk gave a diagnosis recorded as text. The diagnosis itself is never changed (its
-- table refuses it); coding again replaces this row, audited by the API. `version` starts at 2
-- (an uncoded diagnosis reads as version 1) and counts the codings.
CREATE TABLE diagnosis_codings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  diagnosis_id uuid NOT NULL,
  code_id uuid NOT NULL REFERENCES codes (id),
  -- As they read when coded: a set loaded again later may reword the title.
  code text NOT NULL,
  code_title text NOT NULL,
  coded_by uuid NOT NULL,
  coded_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 2 CHECK (version >= 2),
  PRIMARY KEY (tenant_id, diagnosis_id),
  CONSTRAINT diagnosis_codings_diagnosis FOREIGN KEY (tenant_id, diagnosis_id)
    REFERENCES encounter_diagnoses (tenant_id, id)
);

SELECT enable_tenant_rls('diagnosis_codings', 'SELECT, INSERT, UPDATE');

-- Who was asked to complete an incomplete record. A note for the desk: nothing contacts anyone.
CREATE TABLE record_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, encounter_id),
  CONSTRAINT record_assignments_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  CONSTRAINT record_assignments_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id)
);

SELECT enable_tenant_rls('record_assignments', 'SELECT, INSERT, UPDATE, DELETE');

-- A request for a copy of a patient's record, from the patient, an insurer, a court and so on.
-- Closed once, as fulfilled or declined, with a note; a closed request is never changed.
CREATE TABLE record_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  requester_kind text NOT NULL
    CHECK (requester_kind IN ('patient', 'representative', 'insurer', 'court', 'hospital', 'other')),
  requester_name text NOT NULL CHECK (char_length(requester_name) BETWEEN 1 AND 200),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  requested_on date NOT NULL,
  due_on date,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fulfilled', 'declined')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid,
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT record_requests_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT record_requests_closed CHECK (
    (state = 'open' AND closed_at IS NULL AND closed_by IS NULL AND note IS NULL)
    OR (state <> 'open' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND note IS NOT NULL)
  )
);

-- The soonest due first, those with no due day last.
CREATE INDEX record_requests_due ON record_requests
  (tenant_id, state, (coalesce(due_on, DATE '9999-12-31')), id);

SELECT enable_tenant_rls('record_requests', 'SELECT, INSERT');
GRANT UPDATE (state, closed_at, closed_by, note, version) ON record_requests TO mediflow_app;

CREATE FUNCTION record_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'A closed request for a record is never changed' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER record_requests_guard BEFORE UPDATE ON record_requests
  FOR EACH ROW EXECUTE FUNCTION record_requests_guard();

CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON record_requests
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
