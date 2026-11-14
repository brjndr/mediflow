-- A whole-record legal hold copied to the survivor by a patient merge names the record it came
-- from, so an unmerge (#866) releases that copy and never a hold a person placed.
ALTER TABLE document_legal_holds ADD COLUMN merged_from_patient_id uuid;
