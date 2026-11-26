-- #1200: the scanned paper OPD sheet as a document category. It holds the diagnosis, so it always
-- belongs to a visit: who may read it is decided by that visit. Additive: one more allowed value.
ALTER TABLE patient_documents
  DROP CONSTRAINT patient_documents_category_check,
  ADD CONSTRAINT patient_documents_category_check CHECK (category IN
    ('consent', 'referral_letter', 'outside_report', 'id_proof', 'insurance', 'certificate',
     'opd_sheet', 'other')),
  ADD CONSTRAINT patient_documents_opd_sheet_visit
    CHECK (category <> 'opd_sheet' OR encounter_id IS NOT NULL);
ALTER TABLE document_retention_rules
  DROP CONSTRAINT document_retention_rules_category_check,
  ADD CONSTRAINT document_retention_rules_category_check CHECK (category IN
    ('consent', 'referral_letter', 'outside_report', 'id_proof', 'insurance', 'certificate',
     'opd_sheet', 'other'));
