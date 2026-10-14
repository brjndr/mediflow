-- The bulk import centre (MD-07, #68): a file of services, drugs, lab tests or patients, mapped to
-- the fields of its kind in the browser and sent here as rows. The rows are checked by a job, and
-- written by another in one transaction, so a batch is all of its rows or none of them.

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Which kind of record the rows become. The API knows the kinds; the database only their names.
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  -- staging: rows are being sent. checking: the dry run is running. checked: it has run, and
  -- problem_count says whether the batch can be written. queued and running: being written.
  -- committed: every row was written. failed: nothing was written. cancelled: given up, or left
  -- too long (the daily job).
  status text NOT NULL DEFAULT 'staging' CHECK (status IN (
    'staging', 'checking', 'checked', 'queued', 'running', 'committed', 'failed', 'cancelled'
  )),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 20000),
  -- How far the job has got, for the progress bar: rows checked, or rows written.
  done_count integer NOT NULL DEFAULT 0 CHECK (done_count >= 0),
  problem_count integer NOT NULL DEFAULT 0 CHECK (problem_count >= 0),
  -- Why a job stopped, as a code, never a value of a row.
  failure text CHECK (failure ~ '^[a-z][a-z_]{0,59}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  committed_by uuid,
  finished_at timestamptz,
  -- When a job last said it was alive. A job that stops saying so is taken over by the next one,
  -- or given up by the daily job.
  heartbeat_at timestamptz,
  -- Which delivery of a job has the batch: every change the job makes names it, so one that was
  -- taken over changes nothing.
  claim_token uuid,
  CONSTRAINT import_batches_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT import_batches_created_by FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT import_batches_committed_by FOREIGN KEY (tenant_id, committed_by)
    REFERENCES memberships (tenant_id, user_id)
);

-- The list, newest first.
CREATE INDEX import_batches_tenant_list ON import_batches (tenant_id, created_at DESC, id DESC);

-- One batch is written at a time at a hospital: a second waits its turn as a 409.
CREATE UNIQUE INDEX import_batches_one_writing ON import_batches (tenant_id)
  WHERE status IN ('queued', 'running');

-- Never deleted by the app: a batch is a record of who loaded what kind of data, and when.
SELECT enable_tenant_rls('import_batches', 'SELECT, INSERT, UPDATE');

-- The rows as they were sent, field by field, in text. They can be patient data, so they are
-- deleted as soon as the batch is written, failed or given up.
CREATE TABLE import_rows (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL,
  -- The line of the file the row starts on, so a person can find it.
  line integer NOT NULL CHECK (line >= 1),
  "values" jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  PRIMARY KEY (tenant_id, batch_id, line),
  CONSTRAINT import_rows_batch FOREIGN KEY (tenant_id, batch_id)
    REFERENCES import_batches (tenant_id, id)
);

SELECT enable_tenant_rls('import_rows', 'SELECT, INSERT, DELETE');

-- What is wrong with a row: its line, the field when it is one field, and a code. Never the value,
-- so the report of a patient file holds no patient data.
CREATE TABLE import_problems (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL,
  line integer NOT NULL CHECK (line >= 1),
  -- Unique within the batch, so the report pages on it.
  seq integer NOT NULL CHECK (seq >= 1),
  field text CHECK (field ~ '^[A-Za-z][A-Za-z0-9]{0,39}$'),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z_]{0,59}$'),
  PRIMARY KEY (tenant_id, batch_id, seq),
  CONSTRAINT import_problems_batch FOREIGN KEY (tenant_id, batch_id)
    REFERENCES import_batches (tenant_id, id)
);

SELECT enable_tenant_rls('import_problems', 'SELECT, INSERT, DELETE');

-- The daily job gives up the batches left unfinished for a week, or whose job stopped, at every
-- hospital, and deletes their rows. It runs as the worker role, which sees every hospital's
-- batches for that alone: the columns that decide it, never the values of a row.
CREATE POLICY worker_expire ON import_batches FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, status, created_at, heartbeat_at) ON import_batches TO mediflow_worker;
GRANT UPDATE (status, failure, finished_at, heartbeat_at, claim_token) ON import_batches
  TO mediflow_worker;
CREATE POLICY worker_expire ON import_rows FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, batch_id), DELETE ON import_rows TO mediflow_worker;
