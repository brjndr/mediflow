-- Reporting (BE-14, #123): operational reports read from the replica, large ones made by a job,
-- with a quota for each hospital so one hospital's heavy report cannot crowd out the others.

-- The limits a hospital's reports run under. A row is optional: a hospital with none has the
-- defaults below. The app role only reads it, so a hospital cannot raise its own quota; the
-- platform sets it (there is no screen for that yet).
CREATE TABLE report_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  -- Stored reports being made at the same time.
  max_concurrent smallint NOT NULL DEFAULT 2 CHECK (max_concurrent BETWEEN 1 AND 20),
  -- Stored reports asked for in any 24 hours.
  max_per_day integer NOT NULL DEFAULT 50 CHECK (max_per_day BETWEEN 1 AND 10000),
  -- How long a stored report and its file are kept.
  retention_days smallint NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT enable_tenant_rls('report_settings', 'SELECT');

-- A stored report: asked for, made by a job, kept until expires_at. The result holds counts,
-- money and the names of catalog items (departments, tests, drugs), never a patient's record.
CREATE TABLE report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('opd_census', 'revenue', 'lab_turnaround', 'stock')),
  -- Calendar days at the hospital, both ends included. None for a snapshot (stock).
  range_from date,
  range_to date,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  row_count integer CHECK (row_count >= 0),
  result jsonb,
  -- Where the CSV is kept in the file store.
  file_key text CHECK (file_key ~ '^reports/[0-9a-f-]{36}/[0-9a-f-]{36}\.csv$'),
  file_bytes integer CHECK (file_bytes >= 0),
  -- Why a run failed, as a code, never text from the database.
  failure text CHECK (failure ~ '^[a-z][a-z_]{0,59}$'),
  expires_at timestamptz NOT NULL,
  CONSTRAINT report_runs_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT report_runs_requested_by FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT report_runs_range CHECK (
    (range_from IS NULL) = (range_to IS NULL) AND (range_from IS NULL OR range_from <= range_to)
  ),
  CONSTRAINT report_runs_done CHECK (
    (status = 'succeeded') = (result IS NOT NULL AND file_key IS NOT NULL
      AND finished_at IS NOT NULL AND row_count IS NOT NULL)
  ),
  CONSTRAINT report_runs_failed CHECK ((status = 'failed') = (failure IS NOT NULL))
);

CREATE INDEX report_runs_tenant_list ON report_runs (tenant_id, requested_at DESC, id DESC);
-- The quota counts what is waiting or running.
CREATE INDEX report_runs_tenant_active ON report_runs (tenant_id, status)
  WHERE status IN ('queued', 'running');

-- A run is asked for and changes state; the app never deletes one (the retention job does).
SELECT enable_tenant_rls('report_runs', 'SELECT, INSERT, UPDATE');

-- Background work, as the worker role, across hospitals: serving a signed download link (which
-- has no session, so no hospital) and the sweep that gives up stalled runs and deletes expired
-- ones with their files. The columns that decide it, never the result.
CREATE POLICY worker_all ON report_runs FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, kind, range_from, range_to, status, requested_at, expires_at, file_key)
  ON report_runs TO mediflow_worker;
GRANT UPDATE (status, failure, finished_at) ON report_runs TO mediflow_worker;
GRANT DELETE ON report_runs TO mediflow_worker;

-- The reports read by a range of time, so a report touches the range and not the hospital's whole
-- history. Tenant first, as every index of a tenant table.
CREATE INDEX payments_tenant_at ON payments (tenant_id, at);
CREATE INDEX invoices_tenant_issued ON invoices (tenant_id, issued_at) WHERE issued_at IS NOT NULL;
CREATE INDEX credit_notes_tenant_created ON credit_notes (tenant_id, created_at);
CREATE INDEX lab_results_tenant_verified ON lab_results (tenant_id, verified_at)
  WHERE status = 'verified';
