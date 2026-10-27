-- Pharmacy dispensing (#100): what was given against each medication order of a prescription, from
-- which batches at which place. What the database itself guarantees:
--
-- * A dispense moves stock only through the ledger: each of its lines names the ledger entry that
--   took its units out (source 'dispense', reason 'dispense').
-- * A dispense names its order, encounter, patient and the prescribed item together, so it cannot
--   be of an order of another visit or patient. A substitute is another item with a reason.
-- * A dispense and its lines are never changed or removed: a return is a new record (#104).

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense'));

-- So a dispense line names its ledger entry with the entry's hospital and batch.
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_tenant_id_batch UNIQUE (tenant_id, id, batch_id);

-- So a dispense names its order with the order's encounter, patient and item.
ALTER TABLE orders ADD CONSTRAINT orders_tenant_id_medication
  UNIQUE (tenant_id, id, encounter_id, patient_id, drug_id);

-- The pharmacy's queue: the prescriptions with a medication line still to dispense.
CREATE INDEX orders_tenant_medication_open ON orders (tenant_id, prescription_id)
  WHERE type = 'medication' AND status IN ('placed', 'accepted', 'in_progress');
CREATE INDEX prescriptions_tenant_prescribed ON prescriptions (tenant_id, prescribed_at, id);

CREATE TABLE dispenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  prescription_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- The item prescribed, and the item given: another only as a generic substitute, with a reason.
  prescribed_drug_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  substitution_reason text
    CHECK (substitution_reason IS NULL OR length(substitution_reason) BETWEEN 1 AND 200),
  -- The item given as it read when dispensed, so the record reads the same after the catalog
  -- changes: its name (generic name, strength and brand), schedule and whether it is controlled.
  item_name text NOT NULL CHECK (length(item_name) BETWEEN 1 AND 340),
  schedule text NOT NULL,
  controlled boolean NOT NULL,
  -- How many units, the sum of its lines.
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  dispensed_by uuid NOT NULL,
  dispensed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispenses_substitution CHECK ((drug_id <> prescribed_drug_id) = (substitution_reason IS NOT NULL)),
  CONSTRAINT dispenses_order FOREIGN KEY (tenant_id, order_id, encounter_id, patient_id, prescribed_drug_id)
    REFERENCES orders (tenant_id, id, encounter_id, patient_id, drug_id),
  CONSTRAINT dispenses_prescription FOREIGN KEY (tenant_id, prescription_id, encounter_id)
    REFERENCES prescriptions (tenant_id, id, encounter_id),
  CONSTRAINT dispenses_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT dispenses_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT dispenses_tenant_id_drug UNIQUE (tenant_id, id, drug_id)
);

CREATE INDEX dispenses_tenant_order ON dispenses (tenant_id, order_id, dispensed_at, id);
CREATE INDEX dispenses_tenant_prescription ON dispenses (tenant_id, prescription_id, dispensed_at, id);

SELECT enable_tenant_rls('dispenses', 'SELECT, INSERT');

CREATE TABLE dispense_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  dispense_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  -- The entry that took the units out of stock.
  ledger_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT dispense_lines_dispense FOREIGN KEY (tenant_id, dispense_id, drug_id)
    REFERENCES dispenses (tenant_id, id, drug_id),
  CONSTRAINT dispense_lines_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT dispense_lines_batch_once UNIQUE (tenant_id, dispense_id, batch_id),
  CONSTRAINT dispense_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id)
);

CREATE INDEX dispense_lines_tenant_dispense ON dispense_lines (tenant_id, dispense_id);

SELECT enable_tenant_rls('dispense_lines', 'SELECT, INSERT');

-- Never changed or removed, to the owner too.
CREATE FUNCTION dispenses_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'A dispense is never changed or removed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER dispenses_never_change BEFORE UPDATE OR DELETE ON dispenses
  FOR EACH ROW EXECUTE FUNCTION dispenses_never_change();
CREATE TRIGGER dispense_lines_never_change BEFORE UPDATE OR DELETE ON dispense_lines
  FOR EACH ROW EXECUTE FUNCTION dispenses_never_change();
CREATE TRIGGER dispenses_no_truncate BEFORE TRUNCATE ON dispenses
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER dispense_lines_no_truncate BEFORE TRUNCATE ON dispense_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
