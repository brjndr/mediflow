-- #990: a signed consent or an issued certificate rendered as a PDF and kept as a patient
-- document. The document names its source, once: asking again returns the same document.
-- Additive and nullable; the app role already inserts and reads patient_documents.
ALTER TABLE patient_documents
  ADD COLUMN source_consent_id uuid REFERENCES patient_consents (id),
  ADD COLUMN source_certificate_id uuid REFERENCES patient_certificates (id),
  ADD CONSTRAINT patient_documents_one_source
    CHECK (source_consent_id IS NULL OR source_certificate_id IS NULL);
CREATE UNIQUE INDEX patient_documents_source_consent ON patient_documents (source_consent_id)
  WHERE source_consent_id IS NOT NULL;
CREATE UNIQUE INDEX patient_documents_source_certificate ON patient_documents (source_certificate_id)
  WHERE source_certificate_id IS NOT NULL;
