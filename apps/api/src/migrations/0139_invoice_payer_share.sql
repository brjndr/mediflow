-- Billing the payer's share as its own invoice (#977). A visit with an active policy is billed
-- as a pair of invoices in one `split_group`: the patient's share, and the payer's share, which
-- carries `payer_id`. Both are made from the visit's coverage split and the charge ledger;
-- a charge is held by one of them (the patient's, or the payer's when the patient owes nothing)
-- and the other invoice's line points at it too. Additive: invoices outside a split keep both
-- columns empty.

ALTER TABLE invoices
  ADD COLUMN split_group uuid,
  ADD COLUMN payer_id uuid,
  ADD CONSTRAINT invoices_payer FOREIGN KEY (tenant_id, payer_id) REFERENCES payers (tenant_id, id),
  ADD CONSTRAINT invoices_payer_in_group CHECK (payer_id IS NULL OR split_group IS NOT NULL);

-- One live payer invoice for a visit: a second split needs the first to be void.
CREATE UNIQUE INDEX invoices_one_payer_share
  ON invoices (tenant_id, encounter_id) WHERE payer_id IS NOT NULL AND status <> 'void';

CREATE INDEX invoices_tenant_split_group ON invoices (tenant_id, split_group) WHERE split_group IS NOT NULL;

-- An invoice never moves between groups or payers.
CREATE OR REPLACE FUNCTION invoices_split_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.split_group IS DISTINCT FROM OLD.split_group OR NEW.payer_id IS DISTINCT FROM OLD.payer_id THEN
    RAISE EXCEPTION 'An invoice keeps its split and its payer' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_split_guard BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_split_guard();
