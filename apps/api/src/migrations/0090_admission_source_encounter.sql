-- The visit an admission came from (#678): an OPD, daycare or emergency encounter of the same
-- patient that led to the admission. Optional, a reference only (the history stays on that
-- encounter), and never changed after the admission is made.
ALTER TABLE admissions
  ADD COLUMN source_encounter_id uuid,
  ADD CONSTRAINT admissions_source_encounter FOREIGN KEY (tenant_id, source_encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id);
