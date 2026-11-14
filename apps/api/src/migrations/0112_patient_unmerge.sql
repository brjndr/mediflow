-- #555: a merge can be reversed inside a window the hospital sets.
-- * `patient_merges` stays append-only except for three columns given once, when the merge is
--   undone. The unique "merged away once" rule now covers live merges only, so a record that was
--   unmerged may be merged again.
-- * `patients.merged_into_id` can be cleared only in the transaction that marks the merge as
--   undone (the guard looks for that row), never directly.
-- * A document moves back to the record it was taken from only in that same transaction.
-- * `patient_settings.unmerge_window_days`: days after a merge during which it may be undone
--   (0 turns unmerging off). The default is 30.
ALTER TABLE patient_merges
  ADD COLUMN unmerged_at timestamptz,
  ADD COLUMN unmerged_by uuid,
  ADD COLUMN unmerge_reason text CHECK (char_length(unmerge_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT patient_merges_unmerged_whole CHECK (
    (unmerged_at IS NULL) = (unmerged_by IS NULL) AND (unmerged_at IS NULL) = (unmerge_reason IS NULL));
ALTER TABLE patient_merges DROP CONSTRAINT patient_merges_source_once;
CREATE UNIQUE INDEX patient_merges_source_once ON patient_merges (tenant_id, source_patient_id)
  WHERE unmerged_at IS NULL;
GRANT UPDATE (unmerged_at, unmerged_by, unmerge_reason) ON patient_merges TO mediflow_app;

CREATE FUNCTION patient_merges_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unmerged_at IS NOT NULL OR NEW.unmerged_at IS NULL
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.source_patient_id <> OLD.source_patient_id
     OR NEW.target_patient_id <> OLD.target_patient_id OR NEW.reason <> OLD.reason
     OR NEW.moved <> OLD.moved OR NEW.merged_by <> OLD.merged_by OR NEW.merged_at <> OLD.merged_at
  THEN
    RAISE EXCEPTION 'A merge is undone once and is not otherwise changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_merges_guard_update BEFORE UPDATE ON patient_merges
  FOR EACH ROW EXECUTE FUNCTION patient_merges_guard_update();

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
    -- Cleared only by an unmerge: the merge was marked as undone in this transaction.
    IF NEW.merged_into_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM patient_merges m
      WHERE m.tenant_id = OLD.tenant_id AND m.source_patient_id = OLD.id
        AND m.target_patient_id = OLD.merged_into_id AND m.unmerged_at = now()
    ) THEN
      RAISE EXCEPTION 'A merged patient record can only be unmerged, and not merged again'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION patient_documents_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Only a merge moves a document, to the record the old one was merged into; only an unmerge
  -- (marked in this transaction) moves it back to the record it was taken from.
  IF NEW.patient_id <> OLD.patient_id THEN
    IF EXISTS (
      SELECT 1 FROM patient_merges m
      WHERE m.tenant_id = OLD.tenant_id AND m.source_patient_id = NEW.patient_id
        AND m.target_patient_id = OLD.patient_id AND m.unmerged_at = now()
        AND OLD.original_patient_id = NEW.patient_id
    ) THEN
      NEW.original_patient_id := NULL;
    ELSIF NOT EXISTS (
      SELECT 1 FROM patients
      WHERE tenant_id = OLD.tenant_id AND id = OLD.patient_id AND merged_into_id = NEW.patient_id
    ) THEN
      RAISE EXCEPTION 'A document moves only when its patient record is merged'
        USING ERRCODE = '42501';
    ELSE
      NEW.original_patient_id := COALESCE(OLD.original_patient_id, OLD.patient_id);
    END IF;
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

CREATE TABLE patient_settings (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants (id),
  unmerge_window_days integer NOT NULL DEFAULT 30 CHECK (unmerge_window_days BETWEEN 0 AND 365),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('patient_settings', 'SELECT, INSERT, UPDATE');
