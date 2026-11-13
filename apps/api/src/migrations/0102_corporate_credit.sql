-- Corporate credit and receivables (BE-28d, #803): a credit account for a corporate payer, the
-- bills put on it (one per visit), the money received and where each receipt went. What the
-- database itself guarantees:
--
-- * A corporate has one account; a bill is one visit's ledger, once (unique per visit).
-- * A bill's visit, payer, number, dates and amount never change; only the money received on it
--   moves, upward, and never beyond the amount.
-- * Receipts and their allocations are insert-only: a mistake is a new entry, not an edit.
-- * Bill and receipt numbers are gapless within a hospital: the counter row is locked and moved
--   in the transaction that creates the record.
-- Every table carries tenant_id (defaulting to the session's hospital) and row-level security.

CREATE TABLE credit_accounts (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  payer_id uuid NOT NULL,
  credit_limit_minor bigint NOT NULL CHECK (credit_limit_minor BETWEEN 0 AND 2000000000),
  terms_days integer NOT NULL CHECK (terms_days BETWEEN 0 AND 365),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, payer_id),
  CONSTRAINT credit_accounts_payer FOREIGN KEY (tenant_id, payer_id)
    REFERENCES payers (tenant_id, id)
);

CREATE FUNCTION credit_accounts_touch() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.payer_id <> OLD.payer_id THEN
    RAISE EXCEPTION 'The hospital and corporate of an account cannot change' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_accounts_touch BEFORE UPDATE ON credit_accounts
  FOR EACH ROW EXECUTE FUNCTION credit_accounts_touch();

SELECT enable_tenant_rls('credit_accounts', 'SELECT, INSERT, UPDATE');

CREATE TABLE credit_counters (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('bill', 'receipt')),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, kind)
);

SELECT enable_tenant_rls('credit_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE credit_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  seq integer NOT NULL CHECK (seq >= 1),
  payer_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  issued_on date NOT NULL,
  due_on date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 2000000000),
  received_minor bigint NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_bills_money CHECK (received_minor <= amount_minor),
  CONSTRAINT credit_bills_dates CHECK (due_on >= issued_on),
  CONSTRAINT credit_bills_account FOREIGN KEY (tenant_id, payer_id)
    REFERENCES credit_accounts (tenant_id, payer_id),
  CONSTRAINT credit_bills_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  CONSTRAINT credit_bills_number_taken UNIQUE (tenant_id, seq),
  CONSTRAINT credit_bills_one_per_visit UNIQUE (tenant_id, encounter_id),
  CONSTRAINT credit_bills_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX credit_bills_payer ON credit_bills (tenant_id, payer_id, seq);

CREATE FUNCTION credit_bills_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - 'received_minor') IS DISTINCT FROM (to_jsonb(OLD) - 'received_minor') THEN
    RAISE EXCEPTION 'Only the money received on a credit bill changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.received_minor < OLD.received_minor THEN
    RAISE EXCEPTION 'Money received on a credit bill is not taken back' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_bills_guard BEFORE UPDATE ON credit_bills
  FOR EACH ROW EXECUTE FUNCTION credit_bills_guard_update();

SELECT enable_tenant_rls('credit_bills', 'SELECT, INSERT, UPDATE');

CREATE TABLE credit_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  seq integer NOT NULL CHECK (seq >= 1),
  payer_id uuid NOT NULL,
  received_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'cheque', 'card')),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 60),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 2000000000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_receipts_account FOREIGN KEY (tenant_id, payer_id)
    REFERENCES credit_accounts (tenant_id, payer_id),
  CONSTRAINT credit_receipts_number_taken UNIQUE (tenant_id, seq),
  CONSTRAINT credit_receipts_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX credit_receipts_payer ON credit_receipts (tenant_id, payer_id, seq);

SELECT enable_tenant_rls('credit_receipts', 'SELECT, INSERT');

CREATE TABLE credit_receipt_allocations (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  receipt_id uuid NOT NULL,
  bill_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 1),
  PRIMARY KEY (tenant_id, receipt_id, bill_id),
  CONSTRAINT credit_allocations_receipt FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES credit_receipts (tenant_id, id),
  CONSTRAINT credit_allocations_bill FOREIGN KEY (tenant_id, bill_id)
    REFERENCES credit_bills (tenant_id, id)
);

SELECT enable_tenant_rls('credit_receipt_allocations', 'SELECT, INSERT');
