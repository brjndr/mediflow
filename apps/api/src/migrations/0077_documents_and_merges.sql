-- Documents and records (#194): files kept on a patient's record, retention rules for them, and
-- the merge of two records of one person.
--
-- * A document is a file (a consent form, an outside report, an ID proof) attached to a patient
--   and optionally to one of their encounters. It is sent through a signed link and held until a
--   malware scan clears it, as radiology's images are (#99). It is never deleted by a person:
--   it is retired with a reason (kept, hidden from the default list), and only the retention
--   sweep removes the file of a document past its retention, leaving the row as the record that
--   it existed.
-- * A retention rule says how many years a hospital keeps the documents of a category. No rule
--   means for ever. The date is worked out when the document is asked for, so changing a rule
--   never shortens the life of a document already kept.
-- * A merge makes one record (the source) point at another (the survivor). Nothing is deleted
--   and no clinical row is rewritten: documents move to the survivor, where the database
--   itself refuses a move to anything but the record the source was merged into.

CREATE TABLE document_retention_rules (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  category text NOT NULL CHECK (category IN
    ('consent', 'referral_letter', 'outside_report', 'id_proof', 'insurance', 'certificate', 'other')),
  years smallint NOT NULL CHECK (years BETWEEN 1 AND 100),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category)
);

SELECT enable_tenant_rls('document_retention_rules', 'SELECT, INSERT, UPDATE, DELETE');

-- A patient record that was merged into another. Set once, never cleared, never to itself.
ALTER TABLE patients ADD COLUMN merged_into_id uuid;
ALTER TABLE patients ADD CONSTRAINT patients_merged_into FOREIGN KEY (tenant_id, merged_into_id)
  REFERENCES patients (tenant_id, id);
ALTER TABLE patients ADD CONSTRAINT patients_not_merged_into_self CHECK (merged_into_id <> id);
CREATE INDEX patients_tenant_merged_into ON patients (tenant_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE OR REPLACE FUNCTION patients_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.mrn <> OLD.mrn OR NEW.id <> OLD.id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A patient''s hospital, MRN and registration details cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    RAISE EXCEPTION 'A merged patient record cannot be unmerged or merged again'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TABLE patient_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  source_patient_id uuid NOT NULL,
  target_patient_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  -- What moved, by kind, as counts: {"documents": 3}. Never a value.
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_by uuid NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_merges_source FOREIGN KEY (tenant_id, source_patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_merges_target FOREIGN KEY (tenant_id, target_patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_merges_differ CHECK (source_patient_id <> target_patient_id),
  -- A record is merged away once.
  CONSTRAINT patient_merges_source_once UNIQUE (tenant_id, source_patient_id)
);
CREATE INDEX patient_merges_tenant_target ON patient_merges (tenant_id, target_patient_id, merged_at DESC);

-- Append-only: a merge is a medico-legal event.
SELECT enable_tenant_rls('patient_merges', 'SELECT, INSERT');

CREATE TABLE patient_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  -- Where it was before a merge moved it, kept for the record.
  original_patient_id uuid,
  -- The encounter it was taken at, checked against the patient when the document is asked for.
  encounter_id uuid,
  category text NOT NULL CHECK (category IN
    ('consent', 'referral_letter', 'outside_report', 'id_proof', 'insurance', 'certificate', 'other')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  -- pending: link given, nothing received. scanning: received, waiting for the scan.
  -- clean: may be downloaded. infected: file deleted. failed: file lost or not scannable.
  -- purged: past its retention, the file removed by the sweep.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scanning', 'clean', 'infected', 'failed', 'purged')),
  file_key text CHECK (file_key ~ '^documents/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_result text CHECK (scan_result ~ '^[A-Za-z0-9._:-]{1,100}$'),
  -- Worked out when asked for from the category's rule; null keeps it for ever.
  retain_until date,
  retired_at timestamptz,
  retired_by uuid,
  retired_reason text CHECK (char_length(retired_reason) BETWEEN 1 AND 300),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  scanned_at timestamptz,
  purged_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT patient_documents_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_documents_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  CONSTRAINT patient_documents_received CHECK ((status = 'pending') = (uploaded_at IS NULL)),
  CONSTRAINT patient_documents_retired CHECK (
    (retired_at IS NULL) = (retired_by IS NULL) AND (retired_at IS NULL) = (retired_reason IS NULL)
  ),
  CONSTRAINT patient_documents_purged CHECK ((status = 'purged') = (purged_at IS NOT NULL)),
  CONSTRAINT patient_documents_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX patient_documents_tenant_patient
  ON patient_documents (tenant_id, patient_id, created_at DESC, id DESC);
CREATE INDEX patient_documents_retention ON patient_documents (retain_until) WHERE status = 'clean';

-- The app asks for a document, reads, and retires; it never removes one or changes its file.
SELECT enable_tenant_rls('patient_documents', 'SELECT, INSERT');
GRANT UPDATE (patient_id, original_patient_id, retired_at, retired_by, retired_reason, version)
  ON patient_documents TO mediflow_app;

CREATE FUNCTION patient_documents_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Only a merge moves a document, and only to the record the old one was merged into.
  IF NEW.patient_id <> OLD.patient_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM patients
      WHERE tenant_id = OLD.tenant_id AND id = OLD.patient_id AND merged_into_id = NEW.patient_id
    ) THEN
      RAISE EXCEPTION 'A document moves only when its patient record is merged'
        USING ERRCODE = '42501';
    END IF;
    NEW.original_patient_id := COALESCE(OLD.original_patient_id, OLD.patient_id);
  END IF;
  -- A retirement is given once.
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'A document is retired once' USING ERRCODE = '42501';
  END IF;
  -- The version counts what a person changes (a retirement, a merge move), not the scan.
  IF NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.patient_id <> OLD.patient_id THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_documents_guard_update BEFORE UPDATE ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION patient_documents_guard_update();

-- Link, scan and sweep work as the worker role, across hospitals.
CREATE POLICY worker_all ON patient_documents FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, category, file_name, content_type, size_bytes, status, file_key,
  retain_until, retired_at) ON patient_documents TO mediflow_worker;
GRANT UPDATE (status, file_key, sha256, scan_result, uploaded_at, scanned_at, purged_at)
  ON patient_documents TO mediflow_worker;
