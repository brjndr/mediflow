-- Returns of dispensed medicines and their wastage (#104): units a patient brings back of a
-- dispense, each batch's units either back to stock or wasted. What the database itself guarantees:
--
-- * A return moves stock only through the ledger. Units back to stock are one entry into the
--   dispense's batch at its place (source and reason 'dispense_return'). Wasted units are two: the
--   same entry in, then one out (source 'dispense_return', reason 'wastage'), so the stock does not
--   change and the drug register, read from the ledger, still holds every unit of an H1, X,
--   narcotic or controlled item that came back and was destroyed. That the entries are of that
--   source and reason is the handler's to hold.
-- * A returned line is of a batch of its own dispense.
-- * Returns and their lines are never changed or removed.

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense', 'sale', 'sale_return', 'receipt', 'purchase_return',
    'dispense_return'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return', 'receipt', 'purchase_return', 'dispense_return', 'wastage'));

-- So a return names its dispense with the dispense's hospital.
ALTER TABLE dispenses ADD CONSTRAINT dispenses_tenant_id UNIQUE (tenant_id, id);

CREATE TABLE dispense_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  dispense_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  returned_by uuid NOT NULL,
  returned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispense_returns_dispense FOREIGN KEY (tenant_id, dispense_id)
    REFERENCES dispenses (tenant_id, id),
  CONSTRAINT dispense_returns_tenant_id_dispense UNIQUE (tenant_id, id, dispense_id)
);

CREATE INDEX dispense_returns_tenant_dispense ON dispense_returns (tenant_id, dispense_id, returned_at, id);

SELECT enable_tenant_rls('dispense_returns', 'SELECT, INSERT');

CREATE TABLE dispense_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  return_id uuid NOT NULL,
  dispense_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  -- Wasted: brought back and destroyed, never stock again.
  wasted boolean NOT NULL,
  -- The entry that brought the units back.
  ledger_entry_id uuid NOT NULL UNIQUE,
  -- The entry that took wasted units out again; only for wasted units.
  waste_entry_id uuid UNIQUE,
  CONSTRAINT dispense_return_lines_waste CHECK (wasted = (waste_entry_id IS NOT NULL)),
  CONSTRAINT dispense_return_lines_return FOREIGN KEY (tenant_id, return_id, dispense_id)
    REFERENCES dispense_returns (tenant_id, id, dispense_id),
  CONSTRAINT dispense_return_lines_line FOREIGN KEY (tenant_id, dispense_id, batch_id)
    REFERENCES dispense_lines (tenant_id, dispense_id, batch_id),
  CONSTRAINT dispense_return_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT dispense_return_lines_waste_ledger FOREIGN KEY (tenant_id, waste_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT dispense_return_lines_once UNIQUE (tenant_id, return_id, batch_id, wasted)
);

CREATE INDEX dispense_return_lines_tenant_dispense ON dispense_return_lines (tenant_id, dispense_id, batch_id);

SELECT enable_tenant_rls('dispense_return_lines', 'SELECT, INSERT');

-- Never changed or removed, to the owner too.
CREATE TRIGGER dispense_returns_never_change BEFORE UPDATE OR DELETE ON dispense_returns
  FOR EACH ROW EXECUTE FUNCTION dispenses_never_change();
CREATE TRIGGER dispense_return_lines_never_change BEFORE UPDATE OR DELETE ON dispense_return_lines
  FOR EACH ROW EXECUTE FUNCTION dispenses_never_change();
CREATE TRIGGER dispense_returns_no_truncate BEFORE TRUNCATE ON dispense_returns
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER dispense_return_lines_no_truncate BEFORE TRUNCATE ON dispense_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();

-- Entries of one transaction (a wasted unit in, then out) stamped with the transaction's start
-- shared one instant, so the ledger and the register read them in the order of their random ids.
CREATE OR REPLACE FUNCTION stock_ledger_post() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  balance integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A stock ledger entry never changes' USING ERRCODE = '42501';
  END IF;
  -- Either statement locks the balance row until the transaction ends; a negative result breaks
  -- stock_balances_not_negative and the whole statement fails. Stock going out only updates:
  -- Postgres checks an insert's own row before it finds the conflict, so a negative insert would
  -- be refused even where there is stock.
  IF NEW.quantity > 0 THEN
    INSERT INTO stock_balances AS b (tenant_id, batch_id, drug_id, location_id, on_hand)
      VALUES (NEW.tenant_id, NEW.batch_id, NEW.drug_id, NEW.location_id, NEW.quantity)
    ON CONFLICT (tenant_id, batch_id, location_id)
      DO UPDATE SET on_hand = b.on_hand + EXCLUDED.on_hand, updated_at = now()
    RETURNING b.on_hand INTO balance;
  ELSE
    UPDATE stock_balances SET on_hand = on_hand + NEW.quantity, updated_at = now()
    WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.batch_id AND location_id = NEW.location_id
    RETURNING on_hand INTO balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The batch has no stock at the place' USING
        ERRCODE = '23514', TABLE = 'stock_balances', CONSTRAINT = 'stock_balances_not_negative';
    END IF;
  END IF;
  NEW.balance_after := balance;
  -- When it happened is the database's to say, so no entry is back-dated; the clock, not the
  -- transaction's start, so entries of one transaction keep the order they were posted in.
  NEW.at := clock_timestamp();
  RETURN NEW;
END;
$$;
