-- Purchasing (#103, #108): the hospital's suppliers, purchase orders that a second person approves,
-- goods received against an approved order, and goods returned to the supplier. What the database
-- itself guarantees:
--
-- * Stock comes in and goes back only through the ledger: each receipt line names the ledger entry
--   of its batch that brought its units in, each return line the entry that took them out.
-- * An order is approved by someone who neither drafted, last changed nor submitted it, and moves
--   only along its states; its lines change only while it is a draft, and who submitted, approved
--   or ended it never changes once recorded.
-- * A receipt is of an approved order's lines, and of their items; a return is of its receipt's
--   lines and their batches. Receipts and returns, and their lines, are never changed or removed.
-- * Numbers (PO-, GRN-, PRN-) count up per hospital, one counter per kind.

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense', 'sale', 'sale_return', 'receipt', 'purchase_return'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return', 'receipt', 'purchase_return'));

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  -- India's GST number: 15 characters.
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  drug_licence text CHECK (drug_licence IS NULL OR (drug_licence = btrim(drug_licence) AND length(drug_licence) BETWEEN 1 AND 60)),
  phone text CHECK (phone IS NULL OR (phone = btrim(phone) AND length(phone) BETWEEN 5 AND 20)),
  email text CHECK (email IS NULL OR (email = btrim(email) AND length(email) BETWEEN 3 AND 254)),
  address text CHECK (address IS NULL OR (address = btrim(address) AND length(address) BETWEEN 1 AND 300)),
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  CONSTRAINT suppliers_name_taken UNIQUE (tenant_id, name_lower),
  CONSTRAINT suppliers_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX suppliers_tenant_list ON suppliers (tenant_id, archived, name_lower, id);

SELECT enable_tenant_rls('suppliers', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION suppliers_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A supplier''s hospital and identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER suppliers_guard_update BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_guard_update();

CREATE TABLE purchasing_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('order', 'receipt', 'return')),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, kind)
);

SELECT enable_tenant_rls('purchasing_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  number integer NOT NULL CHECK (number >= 1),
  supplier_id uuid NOT NULL,
  -- Where the goods are to be delivered: a receipt's place unless it says another.
  location_id uuid NOT NULL,
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 500)),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'partly_received', 'received', 'closed', 'cancelled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who last changed what is ordered: the creator until someone else edits the draft.
  edited_by uuid NOT NULL,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  -- Who cancelled it, or closed it with goods still to come, and why.
  ended_by uuid,
  ended_at timestamptz,
  end_note text CHECK (end_note IS NULL OR (end_note = btrim(end_note) AND length(end_note) BETWEEN 1 AND 200)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT purchase_orders_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT purchase_orders_supplier FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES suppliers (tenant_id, id),
  CONSTRAINT purchase_orders_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT purchase_orders_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT purchase_orders_tenant_id_supplier UNIQUE (tenant_id, id, supplier_id),
  CONSTRAINT purchase_orders_submitted CHECK (
    (submitted_by IS NULL) = (submitted_at IS NULL)
    AND (status IN ('draft', 'cancelled') OR submitted_by IS NOT NULL)
  ),
  CONSTRAINT purchase_orders_approved CHECK (
    (approved_by IS NULL) = (approved_at IS NULL)
    AND (status IN ('draft', 'submitted', 'cancelled') OR approved_by IS NOT NULL)
    AND (status NOT IN ('draft', 'submitted') OR approved_by IS NULL)
  ),
  CONSTRAINT purchase_orders_ended CHECK (
    (status IN ('closed', 'cancelled')) = (ended_by IS NOT NULL)
    AND (ended_by IS NULL) = (ended_at IS NULL)
    AND (ended_by IS NULL) = (end_note IS NULL)
  ),
  -- Two people: whoever drafted, last changed or submitted it never approves it.
  CONSTRAINT purchase_orders_two_people CHECK (
    approved_by IS NULL
    OR (approved_by <> submitted_by AND approved_by <> created_by AND approved_by <> edited_by)
  )
);

-- The orders newest first, of the hospital, of a status and of a supplier.
CREATE INDEX purchase_orders_tenant_created ON purchase_orders (tenant_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_tenant_status ON purchase_orders (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX purchase_orders_tenant_supplier ON purchase_orders (tenant_id, supplier_id, created_at DESC, id DESC);

SELECT enable_tenant_rls('purchase_orders', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION purchase_orders_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.number <> OLD.number
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An order''s hospital and identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  -- What is ordered, from whom and for where changes while it is a draft only.
  IF OLD.status <> 'draft' AND (NEW.supplier_id <> OLD.supplier_id OR NEW.location_id <> OLD.location_id
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.edited_by <> OLD.edited_by) THEN
    RAISE EXCEPTION 'A submitted order is not edited' USING ERRCODE = '42501';
  END IF;
  -- Who submitted, approved or ended it, and why, never change once recorded.
  IF (OLD.submitted_by IS NOT NULL AND (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at))
     OR (OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
     OR (OLD.ended_by IS NOT NULL AND (NEW.ended_by IS DISTINCT FROM OLD.ended_by
        OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_note IS DISTINCT FROM OLD.end_note)) THEN
    RAISE EXCEPTION 'Who moved an order on never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('partly_received', 'received', 'cancelled'))
    OR (OLD.status = 'partly_received' AND NEW.status IN ('received', 'closed'))
  ) THEN
    RAISE EXCEPTION 'An order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_orders_guard_update BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard_update();

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 200),
  drug_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  -- The price of a unit agreed with the supplier, before tax, in minor units.
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor BETWEEN 0 AND 100000000000),
  CONSTRAINT purchase_order_lines_order FOREIGN KEY (tenant_id, order_id)
    REFERENCES purchase_orders (tenant_id, id),
  CONSTRAINT purchase_order_lines_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT purchase_order_lines_number_once UNIQUE (tenant_id, order_id, line_number),
  CONSTRAINT purchase_order_lines_drug_once UNIQUE (tenant_id, order_id, drug_id),
  -- So a receipt line names its order line with the order and the item.
  CONSTRAINT purchase_order_lines_tenant_id_order_drug UNIQUE (tenant_id, id, order_id, drug_id)
);

CREATE INDEX purchase_order_lines_tenant_order ON purchase_order_lines (tenant_id, order_id, line_number);

SELECT enable_tenant_rls('purchase_order_lines', 'SELECT, INSERT, DELETE');

-- Lines are written while their order is a draft only: never changed, and removed only then.
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  order_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An order line is replaced, never changed' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO order_status FROM purchase_orders
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.order_id, OLD.order_id);
  IF order_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of a submitted order never change' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER purchase_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  number integer NOT NULL CHECK (number >= 1),
  order_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- The supplier's invoice or delivery note the goods came with.
  supplier_invoice text
    CHECK (supplier_invoice IS NULL OR (supplier_invoice = btrim(supplier_invoice) AND length(supplier_invoice) BETWEEN 1 AND 60)),
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 200)),
  received_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goods_receipts_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT goods_receipts_order FOREIGN KEY (tenant_id, order_id, supplier_id)
    REFERENCES purchase_orders (tenant_id, id, supplier_id),
  CONSTRAINT goods_receipts_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT goods_receipts_tenant_id_order UNIQUE (tenant_id, id, order_id),
  CONSTRAINT goods_receipts_tenant_id_supplier UNIQUE (tenant_id, id, supplier_id)
);

CREATE INDEX goods_receipts_tenant_received ON goods_receipts (tenant_id, received_at DESC, id DESC);
CREATE INDEX goods_receipts_tenant_order ON goods_receipts (tenant_id, order_id, received_at, id);

SELECT enable_tenant_rls('goods_receipts', 'SELECT, INSERT');

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 400),
  drug_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  -- What one unit of this delivery cost, before tax, in minor units: the batch's cost.
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor BETWEEN 0 AND 100000000000),
  ledger_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT goods_receipt_lines_receipt FOREIGN KEY (tenant_id, receipt_id, order_id)
    REFERENCES goods_receipts (tenant_id, id, order_id),
  CONSTRAINT goods_receipt_lines_order_line FOREIGN KEY (tenant_id, order_line_id, order_id, drug_id)
    REFERENCES purchase_order_lines (tenant_id, id, order_id, drug_id),
  CONSTRAINT goods_receipt_lines_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT goods_receipt_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT goods_receipt_lines_batch_once UNIQUE (tenant_id, receipt_id, batch_id),
  CONSTRAINT goods_receipt_lines_tenant_id_receipt_batch UNIQUE (tenant_id, id, receipt_id, batch_id)
);

CREATE INDEX goods_receipt_lines_tenant_receipt ON goods_receipt_lines (tenant_id, receipt_id, line_number);
-- What has been received of an order line.
CREATE INDEX goods_receipt_lines_tenant_order_line ON goods_receipt_lines (tenant_id, order_line_id);

SELECT enable_tenant_rls('goods_receipt_lines', 'SELECT, INSERT');

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  number integer NOT NULL CHECK (number >= 1),
  receipt_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  -- Where the units were taken from.
  location_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('expired', 'damaged', 'wrong_item', 'other')),
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 200)),
  returned_by uuid NOT NULL,
  returned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_returns_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT purchase_returns_receipt FOREIGN KEY (tenant_id, receipt_id, supplier_id)
    REFERENCES goods_receipts (tenant_id, id, supplier_id),
  CONSTRAINT purchase_returns_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT purchase_returns_other_note CHECK (reason <> 'other' OR note IS NOT NULL),
  CONSTRAINT purchase_returns_tenant_id_receipt UNIQUE (tenant_id, id, receipt_id)
);

CREATE INDEX purchase_returns_tenant_returned ON purchase_returns (tenant_id, returned_at DESC, id DESC);
CREATE INDEX purchase_returns_tenant_receipt ON purchase_returns (tenant_id, receipt_id, returned_at, id);

SELECT enable_tenant_rls('purchase_returns', 'SELECT, INSERT');

CREATE TABLE purchase_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  return_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  -- The receipt line it sends units of back: of the same receipt as the return, and its batch.
  receipt_line_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  ledger_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT purchase_return_lines_return FOREIGN KEY (tenant_id, return_id, receipt_id)
    REFERENCES purchase_returns (tenant_id, id, receipt_id),
  CONSTRAINT purchase_return_lines_line FOREIGN KEY (tenant_id, receipt_line_id, receipt_id, batch_id)
    REFERENCES goods_receipt_lines (tenant_id, id, receipt_id, batch_id),
  CONSTRAINT purchase_return_lines_ledger FOREIGN KEY (tenant_id, ledger_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT purchase_return_lines_once UNIQUE (tenant_id, return_id, receipt_line_id)
);

CREATE INDEX purchase_return_lines_tenant_return ON purchase_return_lines (tenant_id, return_id);
CREATE INDEX purchase_return_lines_tenant_line ON purchase_return_lines (tenant_id, receipt_line_id);

SELECT enable_tenant_rls('purchase_return_lines', 'SELECT, INSERT');

-- Never changed or removed, to the owner too.
CREATE FUNCTION purchasing_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'A goods receipt or a return is never changed or removed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER goods_receipts_never_change BEFORE UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION purchasing_never_change();
CREATE TRIGGER goods_receipt_lines_never_change BEFORE UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION purchasing_never_change();
CREATE TRIGGER purchase_returns_never_change BEFORE UPDATE OR DELETE ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION purchasing_never_change();
CREATE TRIGGER purchase_return_lines_never_change BEFORE UPDATE OR DELETE ON purchase_return_lines
  FOR EACH ROW EXECUTE FUNCTION purchasing_never_change();
CREATE TRIGGER goods_receipts_no_truncate BEFORE TRUNCATE ON goods_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER goods_receipt_lines_no_truncate BEFORE TRUNCATE ON goods_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER purchase_returns_no_truncate BEFORE TRUNCATE ON purchase_returns
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER purchase_return_lines_no_truncate BEFORE TRUNCATE ON purchase_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
