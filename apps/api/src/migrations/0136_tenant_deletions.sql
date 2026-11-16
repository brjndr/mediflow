-- The hard delete of an offboarded hospital's data (#961, decided in #959). A deletion is requested
-- by one platform admin, approved by a second, and run by a job; nothing deletes on a timer alone.
-- `tenant_deletions` is the platform's table like `tenant_exports`: `hospital_id` has no foreign
-- key and is not called tenant_id, so the record of what was deleted, by whom and on what basis
-- outlives the hospital. Ids, counts, times and codes only.
CREATE TABLE tenant_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- What allows the delete: a downloaded export of the hospital, or the hospital's signed waiver.
  basis text NOT NULL CHECK (basis IN ('export', 'waiver')),
  export_id uuid,
  -- Where the signed waiver is kept (a document number): a reference, never its content.
  waiver_reference text CHECK (char_length(waiver_reference) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'running', 'done', 'failed', 'cancelled')),
  approved_by uuid,
  approved_at timestamptz,
  cancelled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- A code, never the database's own text.
  failure text CHECK (failure ~ '^[a-z_]{1,40}$'),
  table_count integer,
  row_count bigint,
  file_count integer,
  CHECK ((basis = 'export') = (export_id IS NOT NULL)),
  CHECK ((basis = 'waiver') = (waiver_reference IS NOT NULL)),
  -- The second person is enforced here too, not only in the route.
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status NOT IN ('approved', 'running', 'done') OR approved_by IS NOT NULL),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
-- One deletion at a time for a hospital.
CREATE UNIQUE INDEX tenant_deletions_one_open ON tenant_deletions (hospital_id)
  WHERE status IN ('requested', 'approved', 'running');
CREATE INDEX tenant_deletions_hospital ON tenant_deletions (hospital_id, requested_at DESC);

ALTER TABLE tenant_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON tenant_deletions FOR ALL TO mediflow_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenant_deletions TO mediflow_platform;
GRANT UPDATE (status, approved_by, approved_at, cancelled_at, started_at, finished_at, failure,
  table_count, row_count, file_count) ON tenant_deletions TO mediflow_platform;

-- What is left of a deleted hospital is its tombstone: the row stays, so an id and a slug are never
-- reused, with the status `deleted` and the day it was deleted. The contact details are cleared.
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'suspended', 'offboarding', 'deleted'));
ALTER TABLE tenants ADD COLUMN deleted_at timestamptz;
ALTER TABLE tenants DROP CONSTRAINT tenants_offboarding_dates;
ALTER TABLE tenants ADD CONSTRAINT tenants_offboarding_dates CHECK (
  ((status IN ('offboarding', 'deleted')) = (offboarding_requested_at IS NOT NULL))
  AND (delete_after IS NULL OR offboarding_requested_at IS NOT NULL)
  AND ((status = 'deleted') = (deleted_at IS NOT NULL))
);
