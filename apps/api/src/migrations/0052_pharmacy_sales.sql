-- Pharmacy counter sales and their returns (#101): items sold at a place without an in-hospital
-- prescription, from batches, at each batch's price. What the database itself guarantees:
--
-- * A sale moves stock only through the ledger: each line names the ledger entry of its batch that
--   took its units out, and each returned line the entry of the same batch that put them back.
--   That the entries are of source and reason 'sale' and 'sale_return' is the handler's to hold.
-- * A returned line is of a line of its own sale, and of that line's batch.
-- * An outside prescription is recorded whole or not at all, and only for a named patient.
-- * Sales, returns and their lines are never changed or removed.
--
-- The drug register is read from the ledger (every movement of an item that needs one), so no
-- sale or dispense of such an item can be left out of it.

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense', 'sale', 'sale_return'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return'));

-- The register: an item's movements oldest first.
CREATE INDEX stock_ledger_tenant_drug_asc ON stock_ledger (tenant_id, drug_id, at, id);

CREATE TABLE pharmacy_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  location_id uuid NOT NULL,
  -- The buyer when registered; an over-the-counter sale may be to anyone.
  patient_id uuid,
  -- The outside prescription a scheduled item was sold against.
  prescriber_name text CHECK (prescriber_name IS NULL OR length(prescriber_name) BETWEEN 1 AND 120),
  prescriber_registration text
    CHECK (prescriber_registration IS NULL OR length(prescriber_registration) BETWEEN 1 AND 40),
  prescribed_on date,
  -- The sum of its lines, in minor units.
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  sold_by uuid NOT NULL,
  sold_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pharmacy_sales_prescription CHECK (
    (prescriber_name IS NULL) = (prescriber_registration IS NULL)
    AND (prescriber_name IS NULL) = (prescribed_on IS NULL)
    AND (prescriber_name IS NULL OR patient_id IS NOT NULL)
  ),
  CONSTRAINT pharmacy_sales_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT pharmacy_sales_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT pharmacy_sales_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX pharmacy_sales_tenant_sold ON pharmacy_sales (tenant_id, sold_at DESC, id DESC);

SELECT enable_tenant_rls('pharmacy_sales', 'SELECT, INSERT');

CREATE TABLE pharmacy_sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  sale_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 200),
  drug_id uuid NOT NULL,
  -- The item as it read when sold: its name, schedule and whether it is controlled.
  item_name text NOT NULL CHECK (length(item_name) BETWEEN 1 AND 340),
  schedule text NOT NULL,
  controlled boolean NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  -- The batch's price of a unit when sold, in minor units.
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  ledger_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT pharmacy_sale_lines_sale FOREIGN KEY (tenant_id, sale_id)
    REFERENCES pharmacy_sales (tenant_id, id),
  CONSTRAINT pharmacy_sale_lines_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT pharmacy_sale_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT pharmacy_sale_lines_batch_once UNIQUE (tenant_id, sale_id, batch_id),
  CONSTRAINT pharmacy_sale_lines_tenant_id_sale UNIQUE (tenant_id, id, sale_id, batch_id)
);

CREATE INDEX pharmacy_sale_lines_tenant_sale ON pharmacy_sale_lines (tenant_id, sale_id, line_number);

SELECT enable_tenant_rls('pharmacy_sale_lines', 'SELECT, INSERT');

CREATE TABLE pharmacy_sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  sale_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  returned_by uuid NOT NULL,
  returned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pharmacy_sale_returns_sale FOREIGN KEY (tenant_id, sale_id)
    REFERENCES pharmacy_sales (tenant_id, id),
  CONSTRAINT pharmacy_sale_returns_tenant_id_sale UNIQUE (tenant_id, id, sale_id)
);

CREATE INDEX pharmacy_sale_returns_tenant_sale ON pharmacy_sale_returns (tenant_id, sale_id, returned_at, id);

SELECT enable_tenant_rls('pharmacy_sale_returns', 'SELECT, INSERT');

CREATE TABLE pharmacy_sale_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  return_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  -- The sale line it returns units of: of the same sale as the return.
  sale_line_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  ledger_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT pharmacy_sale_return_lines_return FOREIGN KEY (tenant_id, return_id, sale_id)
    REFERENCES pharmacy_sale_returns (tenant_id, id, sale_id),
  CONSTRAINT pharmacy_sale_return_lines_line FOREIGN KEY (tenant_id, sale_line_id, sale_id, batch_id)
    REFERENCES pharmacy_sale_lines (tenant_id, id, sale_id, batch_id),
  CONSTRAINT pharmacy_sale_return_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT pharmacy_sale_return_lines_once UNIQUE (tenant_id, return_id, sale_line_id)
);

CREATE INDEX pharmacy_sale_return_lines_tenant_line ON pharmacy_sale_return_lines (tenant_id, sale_line_id);

SELECT enable_tenant_rls('pharmacy_sale_return_lines', 'SELECT, INSERT');

-- Never changed or removed, to the owner too.
CREATE FUNCTION pharmacy_sales_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'A sale or its return is never changed or removed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER pharmacy_sales_never_change BEFORE UPDATE OR DELETE ON pharmacy_sales
  FOR EACH ROW EXECUTE FUNCTION pharmacy_sales_never_change();
CREATE TRIGGER pharmacy_sale_lines_never_change BEFORE UPDATE OR DELETE ON pharmacy_sale_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_sales_never_change();
CREATE TRIGGER pharmacy_sale_returns_never_change BEFORE UPDATE OR DELETE ON pharmacy_sale_returns
  FOR EACH ROW EXECUTE FUNCTION pharmacy_sales_never_change();
CREATE TRIGGER pharmacy_sale_return_lines_never_change BEFORE UPDATE OR DELETE ON pharmacy_sale_return_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_sales_never_change();
CREATE TRIGGER pharmacy_sales_no_truncate BEFORE TRUNCATE ON pharmacy_sales
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER pharmacy_sale_lines_no_truncate BEFORE TRUNCATE ON pharmacy_sale_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER pharmacy_sale_returns_no_truncate BEFORE TRUNCATE ON pharmacy_sale_returns
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER pharmacy_sale_return_lines_no_truncate BEFORE TRUNCATE ON pharmacy_sale_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
