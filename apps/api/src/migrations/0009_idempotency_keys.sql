-- Idempotency keys (BE-07).
--
-- A client that repeats a create or charge request (a retry, a double click) sends the same
-- Idempotency-Key and gets the first result back instead of a second record. The row is written in
-- the request's own transaction, so a request that fails leaves no key behind and can be retried.
--
-- What is kept of the response depends on the route (see core/idempotency): the whole body only for
-- routes that return no patient data, otherwise just the status and the new record's id. Rows are
-- short-lived: they expire and a daily job removes them.
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  -- A digest of the request, so the same key with a different request is refused, not replayed.
  request_hash text NOT NULL,
  -- Null until the handler has produced its response.
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, key)
);

SELECT enable_tenant_rls('idempotency_keys');

-- The purge job runs as the worker role and sees every hospital's expired rows, and only those.
CREATE INDEX idempotency_keys_expires ON idempotency_keys (expires_at);
CREATE POLICY worker_purge ON idempotency_keys FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (expires_at) ON idempotency_keys TO mediflow_worker;
GRANT DELETE ON idempotency_keys TO mediflow_worker;
