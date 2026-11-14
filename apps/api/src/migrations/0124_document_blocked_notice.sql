-- Telling the uploader about a blocked file (#673).
--
-- A scan that blocks a document (infected, or not scannable) writes an audit entry and a
-- `document.blocked` event, and the uploader sees it on the home page until they dismiss it.
-- `blocked_seen_at` is set by the uploader's dismissal; it is not a change to the document
-- (the version does not count it).
ALTER TABLE patient_documents ADD COLUMN blocked_seen_at timestamptz;
GRANT UPDATE (blocked_seen_at) ON patient_documents TO mediflow_app;
CREATE INDEX patient_documents_blocked ON patient_documents (tenant_id, created_by, created_at DESC)
  WHERE status IN ('infected', 'failed') AND blocked_seen_at IS NULL;

-- The scan job names the uploader on the event it writes (the worker role inserts the event for
-- the document's own hospital).
GRANT SELECT (created_by, scan_result, blocked_seen_at) ON patient_documents TO mediflow_worker;
GRANT INSERT ON outbox TO mediflow_worker;
