-- Voiding one invoice of a split pair (#1033). The other invoice is flagged for the desk to decide
-- (`split_review`), not voided on its own: it may already be paid. The flag stops a draft being
-- issued until the desk takes it off with a reason.
ALTER TABLE invoices
  ADD COLUMN split_review text CHECK (split_review IN ('sibling_void')),
  ADD COLUMN split_review_at timestamptz,
  ADD CONSTRAINT invoices_split_review_in_group CHECK (split_review IS NULL OR split_group IS NOT NULL);

-- A payer's receipt against its invoice, set against the claim of the visit. One row per payment,
-- so a delivered event handled twice allocates once.
CREATE TABLE claim_receipts (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  payment_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, payment_id),
  CONSTRAINT claim_receipts_claim FOREIGN KEY (tenant_id, claim_id) REFERENCES claims (tenant_id, id)
);
CREATE INDEX claim_receipts_claim ON claim_receipts (tenant_id, claim_id);

SELECT enable_tenant_rls('claim_receipts', 'SELECT, INSERT');
