-- #984: a consent may name the encounter it was signed for, so the records desk's missing_consent
-- gap can read structured consents as well as uploaded consent documents. Nullable and additive.
ALTER TABLE patient_consents ADD COLUMN encounter_id uuid;
ALTER TABLE patient_consents ADD CONSTRAINT patient_consents_encounter
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounters (tenant_id, id);
CREATE INDEX patient_consents_encounter_idx ON patient_consents (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;
