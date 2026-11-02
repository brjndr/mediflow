-- stock.expiring (#107): a daily job tells each hospital's subscribers about a batch with stock
-- that is about to expire. A batch is told once, ever: its expiry date never changes, so this
-- table (INSERT and SELECT only) is what keeps a repeat of the job, or a second API instance
-- running it, from sending the same batch twice.

CREATE TABLE stock_expiry_notices (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id),
  CONSTRAINT stock_expiry_notices_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id)
);

SELECT enable_tenant_rls('stock_expiry_notices', 'SELECT, INSERT');

-- The job finds the hospitals that keep stock before it works inside one of them. It may read
-- which hospitals there are and which have the inventory module on, and nothing else of them.
-- The policies see every row, so the grants must stay limited to these columns.
CREATE POLICY worker_list ON tenants FOR SELECT TO mediflow_worker USING (true);
GRANT SELECT (id, status) ON tenants TO mediflow_worker;
CREATE POLICY worker_list ON tenant_features FOR SELECT TO mediflow_worker USING (true);
GRANT SELECT (tenant_id, feature, enabled) ON tenant_features TO mediflow_worker;
