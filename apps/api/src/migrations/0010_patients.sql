-- Patients (BE-09).
--
-- A patient record belongs to exactly one hospital. The medical record number (MRN) is unique
-- within the hospital, not globally, and is handed out from a per-hospital counter in the same
-- transaction as the insert, so a registration that fails leaves no gap and two registrations at
-- once cannot get the same number.

-- One row per hospital. The registering request increments it and holds the row lock until it
-- commits, which is what serialises MRNs within a hospital.
CREATE TABLE patient_mrn_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

SELECT enable_tenant_rls('patient_mrn_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  mrn text NOT NULL CHECK (length(mrn) BETWEEN 1 AND 32),
  first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  dob date NOT NULL,
  gender text NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  phone text NOT NULL CHECK (length(phone) BETWEEN 5 AND 20),
  email text CHECK (length(email) <= 254),
  address text CHECK (length(address) <= 500),
  -- Consent to be contacted, captured at registration for the messaging features that come
  -- later. Null while nobody has asked; once recorded, when and by whom are kept with it.
  contact_consent_given boolean,
  contact_consent_at timestamptz,
  contact_consent_recorded_by text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- What search matches against, kept by the database so it cannot drift from the columns.
  search_text text GENERATED ALWAYS AS (lower(first_name || ' ' || last_name || ' ' || mrn)) STORED,
  phone_digits text GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
  CONSTRAINT patients_mrn_per_tenant UNIQUE (tenant_id, mrn),
  CONSTRAINT patients_consent_complete CHECK (
    (contact_consent_given IS NULL AND contact_consent_at IS NULL AND contact_consent_recorded_by IS NULL)
    OR (contact_consent_given IS NOT NULL AND contact_consent_at IS NOT NULL AND contact_consent_recorded_by IS NOT NULL)
  )
);

-- The list, sorted by name, one cursor page at a time.
CREATE INDEX patients_tenant_name ON patients (tenant_id, lower(last_name), lower(first_name), id);
-- Duplicate check at registration.
CREATE INDEX patients_tenant_dob ON patients (tenant_id, dob);
CREATE INDEX patients_tenant_phone ON patients (tenant_id, phone_digits);
-- "Own" scope: the records a user registered.
CREATE INDEX patients_tenant_created_by ON patients (tenant_id, created_by);
-- Search by part of a name, an MRN or a phone number. GiST (through btree_gist) so the index
-- starts with tenant_id like every other: one hospital's search never walks another's rows.
CREATE INDEX patients_tenant_search ON patients USING gist (tenant_id, search_text gist_trgm_ops);
CREATE INDEX patients_tenant_phone_search ON patients USING gist (tenant_id, phone_digits gist_trgm_ops);

-- No DELETE: a patient record is a medico-legal record. Merging and corrections come later.
SELECT enable_tenant_rls('patients', 'SELECT, INSERT, UPDATE');

-- The hospital and the MRN of a record never change, and nobody can backdate who registered it.
CREATE FUNCTION patients_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.mrn <> OLD.mrn OR NEW.id <> OLD.id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A patient''s hospital, MRN and registration details cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER patients_guard_update BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_guard_update();
