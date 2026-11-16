-- The export of an offboarded hospital's data (#960): one archive of every tenant table, its audit
-- log and its stored files, made by a job and downloaded through a signed link. The rows belong to
-- the platform, not the hospital: like platform_audit_log, `hospital_id` has no foreign key and is
-- not called tenant_id, so the record that an export was made and downloaded outlives the hospital
-- (the deletion in #961 reads it: nothing is deleted until an export was made and downloaded, or a
-- waiver exists). Ids, counts, times and a checksum only; never a name or any patient data.
CREATE TABLE tenant_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- A code (too_large, failed), never the database's own text.
  failure text CHECK (failure ~ '^[a-z_]{1,40}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  file_key text CHECK (file_key ~ '^exports/[0-9a-f-]{36}/[0-9a-f-]{36}\.tar$'),
  file_bytes bigint CHECK (file_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  table_count integer,
  row_count bigint,
  file_count integer,
  -- Downloads, counted when a signed link is used (each one is also in platform_audit_log).
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  CHECK ((status = 'succeeded') = (file_key IS NOT NULL AND sha256 IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
-- One export at a time for a hospital.
CREATE UNIQUE INDEX tenant_exports_one_open ON tenant_exports (hospital_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX tenant_exports_hospital ON tenant_exports (hospital_id, requested_at DESC);

ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON tenant_exports FOR ALL TO mediflow_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenant_exports TO mediflow_platform;
GRANT UPDATE (status, failure, started_at, finished_at, file_key, file_bytes, sha256, table_count,
  row_count, file_count, first_downloaded_at, last_downloaded_at, download_count)
  ON tenant_exports TO mediflow_platform;
