-- Sweep of uploads that were asked for and never sent (#560).
--
-- A pending upload whose link has expired is marked `failed` with the scan_result `never_sent`;
-- the row stays as the record that it was asked for. It has no `uploaded_at`, so the "received"
-- checks accept that one combination. The worker role (the sweep job) must see when the row was
-- made.

ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_received;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_received CHECK (
  (status = 'pending') = (uploaded_at IS NULL)
  OR (status = 'failed' AND uploaded_at IS NULL AND scan_result = 'never_sent')
);
GRANT SELECT (created_at) ON patient_documents TO mediflow_worker;
CREATE INDEX patient_documents_unsent ON patient_documents (created_at) WHERE status = 'pending';

ALTER TABLE imaging_images DROP CONSTRAINT imaging_images_received;
ALTER TABLE imaging_images ADD CONSTRAINT imaging_images_received CHECK (
  (status = 'pending') = (uploaded_at IS NULL)
  OR (status = 'failed' AND uploaded_at IS NULL AND scan_result = 'never_sent')
);
GRANT SELECT (created_at) ON imaging_images TO mediflow_worker;
CREATE INDEX imaging_images_unsent ON imaging_images (created_at) WHERE status = 'pending';
