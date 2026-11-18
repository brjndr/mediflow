-- Claims and a patient merge (#1044). A claim still being put together or answered (draft,
-- submitted, query) moves to the surviving record with the merge, like the documents of its packet;
-- a claim already decided stays on the record it was made for. The ids moved are kept here so an
-- unmerge gives back exactly those and no claim created since.
--
-- A claim's visit and policy stay on the record they were written for (clinical rows never move),
-- so the foreign keys no longer carry the patient. A claim is still made from its visit's patient.
ALTER TABLE claims DROP CONSTRAINT claims_encounter;
ALTER TABLE claims DROP CONSTRAINT claims_policy;
ALTER TABLE claims
  ADD CONSTRAINT claims_encounter FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounters (tenant_id, id),
  ADD CONSTRAINT claims_policy FOREIGN KEY (tenant_id, policy_id) REFERENCES patient_policies (tenant_id, id);

CREATE TABLE claim_merge_moves (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  claim_id uuid NOT NULL,
  from_patient_id uuid NOT NULL,
  to_patient_id uuid NOT NULL,
  moved_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  PRIMARY KEY (tenant_id, claim_id, from_patient_id, to_patient_id, moved_at),
  CONSTRAINT claim_merge_moves_claim FOREIGN KEY (tenant_id, claim_id) REFERENCES claims (tenant_id, id)
);
CREATE INDEX claim_merge_moves_open ON claim_merge_moves (tenant_id, from_patient_id, to_patient_id)
  WHERE undone_at IS NULL;
SELECT enable_tenant_rls('claim_merge_moves', 'SELECT, INSERT, UPDATE');

CREATE OR REPLACE FUNCTION claims_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.patient_id <> OLD.patient_id THEN
    -- Only a merge moves a claim (to the record its patient was merged into, and only while it is
    -- still open), and only an unmerge, marked in this transaction, moves it back.
    IF NOT (
      (OLD.status IN ('draft', 'submitted', 'query') AND EXISTS (
        SELECT 1 FROM patients p
        WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.patient_id
          AND p.merged_into_id = NEW.patient_id))
      OR EXISTS (
        SELECT 1 FROM patient_merges m
        WHERE m.tenant_id = OLD.tenant_id AND m.source_patient_id = NEW.patient_id
          AND m.target_patient_id = OLD.patient_id AND m.unmerged_at = now())
    ) THEN
      RAISE EXCEPTION 'A claim moves only when its patient record is merged'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['patient_id', 'approved_minor', 'received_minor', 'written_off_minor',
        'status', 'reference_number', 'open_query', 'documents', 'submitted_at', 'decided_at',
        'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['patient_id', 'approved_minor', 'received_minor', 'written_off_minor',
        'status', 'reference_number', 'open_query', 'documents', 'submitted_at', 'decided_at',
        'version', 'updated_at']) THEN
    RAISE EXCEPTION 'The visit, policy, payer, number and claimed amount of a claim do not change'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('cancelled', 'written_off') AND NEW.patient_id = OLD.patient_id THEN
    RAISE EXCEPTION 'A cancelled or written-off claim is not changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
