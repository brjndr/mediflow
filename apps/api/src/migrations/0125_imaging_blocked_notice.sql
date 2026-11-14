-- Telling the uploader about a blocked radiology image (#926), as #673 did for documents.
--
-- A scan that blocks an image (infected, or not scannable) writes an audit entry and an
-- `imaging.blocked` event, and the uploader sees it on the home page until they dismiss it.
-- `blocked_seen_at` is set by the uploader's dismissal; the image itself does not change.
ALTER TABLE imaging_images ADD COLUMN blocked_seen_at timestamptz;
GRANT UPDATE (blocked_seen_at) ON imaging_images TO mediflow_app;
CREATE INDEX imaging_images_blocked ON imaging_images (tenant_id, created_by, created_at DESC)
  WHERE status IN ('infected', 'failed') AND blocked_seen_at IS NULL;

-- The scan job names the uploader on the event they write, as the worker role for
-- the image's own hospital, in the transaction that sets the status (INSERT on outbox was granted in 0124).
GRANT SELECT (created_by, scan_result, blocked_seen_at) ON imaging_images TO mediflow_worker;
