-- The deletion job removes stored files only after the rows are gone and committed (#995). The
-- keys are kept on the deletion's own row, in the same transaction as the rows, so a run that
-- stops between the commit and the file removal can be finished by the sweep. Keys only: they
-- carry ids and no patient data.
ALTER TABLE tenant_deletions ADD COLUMN file_keys text[];
ALTER TABLE tenant_deletions ADD COLUMN files_deleted_at timestamptz;
GRANT UPDATE (file_keys, files_deleted_at) ON tenant_deletions TO mediflow_platform;
