-- The deletion sweep stops retrying file removal after a cap (#1001). The count of failed
-- attempts and the moment the cap was reached live on the deletion's row; an operator clears
-- files_stuck_at (and the count) to let the sweep try again.
ALTER TABLE tenant_deletions ADD COLUMN file_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_deletions ADD COLUMN files_stuck_at timestamptz;
GRANT UPDATE (file_attempts, files_stuck_at) ON tenant_deletions TO mediflow_platform;
