-- Consumables of a surgery brought back to stock (#892). Additive.
--
-- * The ledger gets the reason `theatre_return` (source stays `theatre`).
-- * ot_consumable_returns is insert-only: one row for each return of units of a consumable
--   row, with the reason and the person, and the ledger entry that put the units back.

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return', 'receipt', 'purchase_return', 'dispense_return', 'wastage',
    'issue_out', 'issue_in', 'theatre_use', 'theatre_return'));

CREATE TABLE ot_consumable_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  consumable_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  ledger_entry_id uuid NOT NULL,
  returned_by uuid NOT NULL,
  returned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_consumable_returns_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
CREATE INDEX ot_consumable_returns_consumable
  ON ot_consumable_returns (tenant_id, consumable_id);
SELECT enable_tenant_rls('ot_consumable_returns', 'SELECT, INSERT');
