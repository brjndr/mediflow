-- Emergency care and disposition (ER-02, #172).
--
-- * A case may get an emergency encounter (type 'er') once the patient is known, so orders go
--   through the clinical module's one table of orders, and observation notes of its own
--   (er_notes, append-only: a correction is a new note).
-- * Leaving the department is a disposition: discharge, admit (the inpatient admission it made is
--   kept on the case), refer or expired. A disposed case is closed for good.

ALTER TABLE er_encounters
  ADD COLUMN encounter_id uuid,
  ADD COLUMN disposition text CHECK (disposition IN ('discharge', 'admit', 'refer', 'expired')),
  ADD COLUMN disposed_at timestamptz,
  ADD COLUMN disposed_by uuid,
  ADD COLUMN disposition_note text CHECK (disposition_note IS NULL OR char_length(disposition_note) BETWEEN 1 AND 500),
  ADD COLUMN destination text CHECK (destination IS NULL OR char_length(destination) BETWEEN 1 AND 120),
  ADD COLUMN death_at timestamptz,
  ADD COLUMN admission_id uuid,
  ADD CONSTRAINT er_encounters_disposed CHECK (
    (status = 'disposed') = (disposition IS NOT NULL)
    AND (disposition IS NULL) = (disposed_at IS NULL)
    AND (disposition IS NULL) = (disposed_by IS NULL)
  ),
  ADD CONSTRAINT er_encounters_disposition_parts CHECK (
    (destination IS NULL OR disposition = 'refer')
    AND (death_at IS NULL OR disposition = 'expired')
    AND (admission_id IS NULL OR disposition = 'admit')
  ),
  ADD CONSTRAINT er_encounters_clinical_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  ADD CONSTRAINT er_encounters_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  ADD CONSTRAINT er_encounters_one_encounter UNIQUE (tenant_id, encounter_id);

CREATE OR REPLACE FUNCTION er_encounters_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  moving text[] := ARRAY['patient_id', 'category', 'status', 'triaged_at', 'identified_at', 'version',
                         'updated_at', 'encounter_id', 'disposition', 'disposed_at', 'disposed_by',
                         'disposition_note', 'destination', 'death_at', 'admission_id'];
BEGIN
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'Only the triage, status, identity and disposition of a case change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'disposed' THEN
    RAISE EXCEPTION 'A case that has left the department is closed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Observation notes and assessments of a case. Never changed or removed.
CREATE TABLE er_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  case_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('observation', 'assessment')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT er_notes_case FOREIGN KEY (tenant_id, case_id)
    REFERENCES er_encounters (tenant_id, id)
);
CREATE INDEX er_notes_case ON er_notes (tenant_id, case_id, created_at, id);
SELECT enable_tenant_rls('er_notes', 'SELECT, INSERT');
