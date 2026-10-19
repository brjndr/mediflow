-- Clinical (BE-12): the encounter every clinical, ordering and billing record attaches to, the
-- notes and diagnoses of the consultation, and the one table of orders (lab, imaging, procedure,
-- medication, diet) with the prescriptions that place medication orders. What the database itself
-- guarantees:
--
-- * An encounter moves only open -> closed or open -> cancelled, and both are final. Its patient,
--   type, links and opening never change. A queue token or an appointment opens one encounter
--   that is not cancelled.
-- * A signed note never changes and is never removed. An edit after signing is an amendment: a
--   new signed note naming the one it amends, with a reason. A note is amended once, so the
--   history never forks: a later edit amends the amendment.
-- * A diagnosis never changes; it is retracted once, with who, when and why, and stays.
-- * An order moves only placed -> accepted -> in_progress -> completed, or to cancelled from
--   placed or accepted with a reason; completed and cancelled are final. What was ordered never
--   changes. A prescription never changes: a revision is a new prescription naming the one it
--   replaces, and a prescription is replaced once.
-- * Every child names its encounter and patient together, and every reference carries the
--   hospital, since foreign keys are checked without row-level security.

CREATE TABLE encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('opd', 'ipd', 'er', 'daycare')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  appointment_id uuid,
  queue_token_id uuid,
  attending_doctor_id uuid,
  department_id uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid NOT NULL,
  -- When and by whom it was closed or cancelled.
  ended_at timestamptz,
  ended_by uuid,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounters_ended CHECK (
    (status = 'open') = (ended_at IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL)
  ),
  CONSTRAINT encounters_cancel_reason CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT encounters_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT encounters_appointment FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES appointments (tenant_id, id),
  CONSTRAINT encounters_token FOREIGN KEY (tenant_id, queue_token_id)
    REFERENCES queue_tokens (tenant_id, id),
  CONSTRAINT encounters_doctor FOREIGN KEY (tenant_id, attending_doctor_id)
    REFERENCES doctors (tenant_id, id),
  CONSTRAINT encounters_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT encounters_tenant_id_id UNIQUE (tenant_id, id),
  -- So a child names the encounter and its patient together.
  CONSTRAINT encounters_tenant_id_patient UNIQUE (tenant_id, id, patient_id)
);

CREATE UNIQUE INDEX encounters_one_per_token ON encounters (tenant_id, queue_token_id)
  WHERE queue_token_id IS NOT NULL AND status <> 'cancelled';
CREATE UNIQUE INDEX encounters_one_per_appointment ON encounters (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'cancelled';
-- A patient's encounters, newest first, and the hospital's.
CREATE INDEX encounters_tenant_patient ON encounters (tenant_id, patient_id, opened_at DESC, id DESC);
CREATE INDEX encounters_tenant_opened ON encounters (tenant_id, opened_at DESC, id DESC);

SELECT enable_tenant_rls('encounters', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION encounters_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR (to_jsonb(NEW) - ARRAY['status', 'ended_at', 'ended_by', 'cancel_reason', 'version', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'ended_at', 'ended_by', 'cancel_reason', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'An encounter only closes or is cancelled, once'
      USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER encounters_guard_update BEFORE UPDATE ON encounters
  FOR EACH ROW EXECUTE FUNCTION encounters_guard_update();

-- The readings of triage name their encounter (0036 could not: the table did not exist), of the
-- same patient.
ALTER TABLE vitals ADD CONSTRAINT vitals_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
  REFERENCES encounters (tenant_id, id, patient_id);

CREATE TABLE clinical_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  -- The rich text document of the app, reduced to its allowlist by the API.
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  author_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  amends_id uuid,
  amendment_reason text
    CHECK (amendment_reason IS NULL OR length(amendment_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT clinical_notes_signed CHECK ((status = 'signed') = (signed_at IS NOT NULL)),
  CONSTRAINT clinical_notes_amendment CHECK (
    (amends_id IS NULL) = (amendment_reason IS NULL) AND (amends_id IS NULL OR status = 'signed')
  ),
  CONSTRAINT clinical_notes_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT clinical_notes_tenant_id_encounter UNIQUE (tenant_id, id, encounter_id),
  -- An amendment amends a note of the same encounter.
  CONSTRAINT clinical_notes_amends FOREIGN KEY (tenant_id, amends_id, encounter_id)
    REFERENCES clinical_notes (tenant_id, id, encounter_id)
);

CREATE UNIQUE INDEX clinical_notes_amended_once ON clinical_notes (tenant_id, amends_id)
  WHERE amends_id IS NOT NULL;
CREATE INDEX clinical_notes_tenant_encounter ON clinical_notes (tenant_id, encounter_id, created_at, id);

-- DELETE for discarding a draft only (the trigger below).
SELECT enable_tenant_rls('clinical_notes', 'SELECT, INSERT, UPDATE, DELETE');

CREATE FUNCTION clinical_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'A signed note is never changed or removed; it is amended'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'body', 'signed_at', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'body', 'signed_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A note keeps its encounter, author and what it amends'
      USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_notes_guard BEFORE UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION clinical_notes_guard();

CREATE TABLE encounter_diagnoses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- An ICD-10 code of the shared code sets, or text alone, or both.
  code_id uuid REFERENCES codes (id),
  -- The code and its title as they read when recorded: a set loaded again later may reword it.
  code text,
  code_title text,
  text text CHECK (text IS NULL OR length(text) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('provisional', 'final')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  retracted_at timestamptz,
  retracted_by uuid,
  retraction_reason text
    CHECK (retraction_reason IS NULL OR length(retraction_reason) BETWEEN 1 AND 200),
  CONSTRAINT encounter_diagnoses_what CHECK (num_nonnulls(code_id, text) > 0),
  CONSTRAINT encounter_diagnoses_code CHECK (num_nulls(code_id, code, code_title) IN (0, 3)),
  CONSTRAINT encounter_diagnoses_retraction CHECK (
    num_nulls(retracted_at, retracted_by, retraction_reason) IN (0, 3)
  ),
  CONSTRAINT encounter_diagnoses_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id)
);

CREATE INDEX encounter_diagnoses_tenant_encounter
  ON encounter_diagnoses (tenant_id, encounter_id, recorded_at, id);

SELECT enable_tenant_rls('encounter_diagnoses', 'SELECT, INSERT');
GRANT UPDATE (retracted_at, retracted_by, retraction_reason) ON encounter_diagnoses TO mediflow_app;

CREATE FUNCTION encounter_diagnoses_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.retracted_at IS NOT NULL OR NEW.retracted_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['retracted_at', 'retracted_by', 'retraction_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['retracted_at', 'retracted_by', 'retraction_reason']) THEN
    RAISE EXCEPTION 'A diagnosis is never changed; it is retracted, once'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER encounter_diagnoses_guard_update BEFORE UPDATE ON encounter_diagnoses
  FOR EACH ROW EXECUTE FUNCTION encounter_diagnoses_guard_update();

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  prescribed_at timestamptz NOT NULL DEFAULT now(),
  prescribed_by uuid NOT NULL,
  -- Advice for the patient: plain text of several lines, tidied by the API.
  advice text CHECK (advice IS NULL OR length(advice) BETWEEN 1 AND 1000),
  replaces_id uuid,
  replace_reason text CHECK (replace_reason IS NULL OR length(replace_reason) BETWEEN 1 AND 200),
  CONSTRAINT prescriptions_replacement CHECK ((replaces_id IS NULL) = (replace_reason IS NULL)),
  CONSTRAINT prescriptions_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT prescriptions_tenant_id_encounter UNIQUE (tenant_id, id, encounter_id),
  CONSTRAINT prescriptions_replaces FOREIGN KEY (tenant_id, replaces_id, encounter_id)
    REFERENCES prescriptions (tenant_id, id, encounter_id)
);

CREATE UNIQUE INDEX prescriptions_replaced_once ON prescriptions (tenant_id, replaces_id)
  WHERE replaces_id IS NOT NULL;
CREATE INDEX prescriptions_tenant_encounter
  ON prescriptions (tenant_id, encounter_id, prescribed_at, id);

-- Never changed or removed.
SELECT enable_tenant_rls('prescriptions', 'SELECT, INSERT');

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('lab', 'imaging', 'procedure', 'medication', 'diet')),
  -- What was ordered, from master data: a test, a service (imaging, procedure) or a drug.
  lab_test_id uuid,
  service_id uuid,
  drug_id uuid,
  -- The item as it read when ordered (a test's or service's name, a drug's generic name and
  -- strength), so the order reads the same after the catalog changes. A diet order has none.
  item_code text CHECK (item_code IS NULL OR length(item_code) BETWEEN 1 AND 30),
  -- A drug's name is its generic name, strength and brand: up to 150 + 30 + 150 and the joins.
  item_name text CHECK (item_name IS NULL OR length(item_name) BETWEEN 1 AND 340),
  -- A medication order is a line of a prescription.
  prescription_id uuid,
  -- Its place in the prescription, from 1: the lines are written in one transaction, at one time.
  line_number smallint CHECK (line_number BETWEEN 1 AND 30),
  status text NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'accepted', 'in_progress', 'completed', 'cancelled')),
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'urgent', 'stat')),
  -- Plain text, tidied by the API. A diet order is its instructions.
  instructions text CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500),
  -- A medication order: dose and frequency as written ("500 mg", "1-0-1"), the route, for how
  -- many days and how much to dispense.
  dose text CHECK (dose IS NULL OR length(dose) BETWEEN 1 AND 50),
  route text CHECK (route IN (
    'oral', 'sublingual', 'topical', 'inhaled', 'nasal', 'eye', 'ear', 'rectal', 'vaginal',
    'intramuscular', 'intravenous', 'subcutaneous', 'other'
  )),
  frequency text CHECK (frequency IS NULL OR length(frequency) BETWEEN 1 AND 50),
  duration_days integer CHECK (duration_days BETWEEN 1 AND 365),
  quantity integer CHECK (quantity BETWEEN 1 AND 10000),
  placed_at timestamptz NOT NULL DEFAULT now(),
  ordered_by uuid NOT NULL,
  status_changed_at timestamptz,
  status_changed_by uuid,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT orders_what CHECK (
    CASE type
      WHEN 'lab' THEN lab_test_id IS NOT NULL AND num_nonnulls(service_id, drug_id, prescription_id) = 0
      WHEN 'imaging' THEN service_id IS NOT NULL AND num_nonnulls(lab_test_id, drug_id, prescription_id) = 0
      WHEN 'procedure' THEN service_id IS NOT NULL AND num_nonnulls(lab_test_id, drug_id, prescription_id) = 0
      WHEN 'medication' THEN drug_id IS NOT NULL AND prescription_id IS NOT NULL
        AND dose IS NOT NULL AND frequency IS NOT NULL AND route IS NOT NULL
        AND num_nonnulls(lab_test_id, service_id) = 0
      WHEN 'diet' THEN instructions IS NOT NULL
        AND num_nonnulls(lab_test_id, service_id, drug_id, prescription_id) = 0
    END
  ),
  CONSTRAINT orders_line CHECK ((prescription_id IS NULL) = (line_number IS NULL)),
  CONSTRAINT orders_line_once UNIQUE (tenant_id, prescription_id, line_number),
  CONSTRAINT orders_item CHECK ((type = 'diet') = (item_name IS NULL)),
  CONSTRAINT orders_medication_only CHECK (
    type = 'medication' OR num_nonnulls(dose, route, frequency, duration_days, quantity) = 0
  ),
  CONSTRAINT orders_cancel_reason CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT orders_status_changed CHECK (
    (status = 'placed') = (status_changed_at IS NULL)
    AND (status_changed_at IS NULL) = (status_changed_by IS NULL)
  ),
  CONSTRAINT orders_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT orders_lab_test FOREIGN KEY (tenant_id, lab_test_id) REFERENCES lab_tests (tenant_id, id),
  CONSTRAINT orders_service FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  CONSTRAINT orders_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT orders_prescription FOREIGN KEY (tenant_id, prescription_id, encounter_id)
    REFERENCES prescriptions (tenant_id, id, encounter_id),
  CONSTRAINT orders_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX orders_tenant_encounter ON orders (tenant_id, encounter_id, placed_at, id);

SELECT enable_tenant_rls('orders', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION orders_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT (
       (OLD.status = 'placed' AND NEW.status IN ('accepted', 'cancelled'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'Order % cannot become %', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'status_changed_at', 'status_changed_by', 'cancel_reason', 'version'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'status_changed_at', 'status_changed_by', 'cancel_reason', 'version']) THEN
    RAISE EXCEPTION 'What was ordered never changes'
      USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_update();
