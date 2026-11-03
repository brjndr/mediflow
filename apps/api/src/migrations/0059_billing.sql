-- Billing (#114): the charge ledger, invoices assembled from charges, payments and refunds,
-- credit notes, invoice numbers by fiscal year and cash register sessions. What the database
-- itself guarantees:
--
-- * A charge is posted once for what caused it (`source_ref`) and is never repriced, renamed or
--   moved to another visit. Only its status, the invoice holding it and its review flag change.
-- * An invoice is changed while it is a draft. Once issued, its number, visit, patient, lines
--   and total never change; only what has been paid or credited, its status and its version.
-- * Payments, refunds and credit notes are never changed or removed.
-- * Invoice numbers are gapless within a fiscal year: the counter row is locked and moved in the
--   transaction that issues, so a rolled-back issue gives its number back.
-- * A closed cash register session is never changed, and a person has one open at a time.

CREATE TABLE invoice_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- 'invoice' or 'credit_note': each series is numbered on its own.
  series text NOT NULL CHECK (series IN ('invoice', 'credit_note')),
  -- April to March, written 2026-27.
  fiscal_year text NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, series, fiscal_year)
);

SELECT enable_tenant_rls('invoice_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  service_id uuid,
  source text NOT NULL CHECK (source IN ('service', 'order', 'dispense', 'bed', 'procedure', 'manual')),
  -- What caused it, such as 'order:<id>' or 'dispense:<line id>': one charge for each, so a
  -- repeated event posts nothing.
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  -- Minor units of the hospital's currency, from the price list in effect when posted.
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 100000000000),
  total_minor bigint GENERATED ALWAYS AS (quantity * unit_price_minor) STORED,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'void')),
  -- The draft (or, once issued, the invoice) holding the charge.
  invoice_id uuid,
  -- For the billing desk: the service was archived or had no price when posted, or what was
  -- dispensed was brought back after.
  flag text CHECK (flag IS NULL OR flag IN ('service_archived', 'no_price', 'return_review')),
  posted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT charges_source_taken UNIQUE (tenant_id, source_ref),
  CONSTRAINT charges_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT charges_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT charges_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  CONSTRAINT charges_held CHECK ((status = 'invoiced') <= (invoice_id IS NOT NULL))
);

CREATE INDEX charges_tenant_encounter ON charges (tenant_id, encounter_id, posted_at DESC, id DESC);
CREATE INDEX charges_tenant_invoice ON charges (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;

SELECT enable_tenant_rls('charges', 'SELECT, INSERT, UPDATE');

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  number text,
  fiscal_year text CHECK (fiscal_year IS NULL OR fiscal_year ~ '^\d{4}-\d{2}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor BETWEEN 0 AND 9007199254740991),
  -- Net of refunds, and the credit notes against it: both in minor units.
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  credited_minor bigint NOT NULL DEFAULT 0 CHECK (credited_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid,
  issued_at timestamptz,
  CONSTRAINT invoices_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT invoices_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT invoices_tenant_id_encounter UNIQUE (tenant_id, id, encounter_id),
  CONSTRAINT invoices_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT invoices_issued CHECK (
    (status = 'draft') = (number IS NULL AND issued_at IS NULL AND issued_by IS NULL
      AND fiscal_year IS NULL)
    AND (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL
      AND issued_by IS NOT NULL AND fiscal_year IS NOT NULL))
  ),
  CONSTRAINT invoices_settled CHECK (paid_minor + credited_minor <= total_minor OR status = 'void')
);

CREATE INDEX invoices_tenant_encounter ON invoices (tenant_id, encounter_id, created_at DESC, id DESC);

SELECT enable_tenant_rls('invoices', 'SELECT, INSERT, UPDATE');

ALTER TABLE charges ADD CONSTRAINT charges_invoice FOREIGN KEY (tenant_id, invoice_id, encounter_id)
  REFERENCES invoices (tenant_id, id, encounter_id);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 250),
  -- The charge it was made from; empty for a line typed in.
  charge_id uuid,
  source text NOT NULL CHECK (source IN ('service', 'order', 'dispense', 'bed', 'procedure', 'manual')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 100000000000),
  total_minor bigint GENERATED ALWAYS AS (quantity * unit_price_minor) STORED,
  CONSTRAINT invoice_lines_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoices (tenant_id, id),
  CONSTRAINT invoice_lines_charge FOREIGN KEY (tenant_id, charge_id)
    REFERENCES charges (tenant_id, id),
  CONSTRAINT invoice_lines_manual CHECK ((source = 'manual') = (charge_id IS NULL)),
  CONSTRAINT invoice_lines_number UNIQUE (tenant_id, invoice_id, line_number)
);

CREATE INDEX invoice_lines_tenant_invoice ON invoice_lines (tenant_id, invoice_id, line_number);

SELECT enable_tenant_rls('invoice_lines', 'SELECT, INSERT, DELETE');

CREATE TABLE cash_register_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_minor bigint NOT NULL CHECK (opening_minor BETWEEN 0 AND 9007199254740991),
  closed_by uuid,
  closed_at timestamptz,
  -- Worked out by the server when it closes: the opening cash and the cash taken, less refunds.
  expected_minor bigint,
  counted_minor bigint CHECK (counted_minor IS NULL OR counted_minor >= 0),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300),
  CONSTRAINT cash_register_sessions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT cash_register_sessions_closed CHECK (
    (closed_at IS NULL) = (closed_by IS NULL AND expected_minor IS NULL AND counted_minor IS NULL)
  )
);

CREATE INDEX cash_register_sessions_tenant_opened
  ON cash_register_sessions (tenant_id, opened_at DESC, id DESC);
-- One open session for a person.
CREATE UNIQUE INDEX cash_register_sessions_one_open
  ON cash_register_sessions (tenant_id, opened_by) WHERE closed_at IS NULL;

SELECT enable_tenant_rls('cash_register_sessions', 'SELECT, INSERT, UPDATE');

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment', 'refund')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank', 'other')),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 60),
  -- A refund is of one payment, and says why.
  refund_of uuid,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  -- Cash goes through a register session.
  session_id uuid,
  recorded_by uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT payments_tenant_id_invoice UNIQUE (tenant_id, id, invoice_id),
  CONSTRAINT payments_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoices (tenant_id, id),
  CONSTRAINT payments_refund_of FOREIGN KEY (tenant_id, refund_of, invoice_id)
    REFERENCES payments (tenant_id, id, invoice_id),
  CONSTRAINT payments_session FOREIGN KEY (tenant_id, session_id)
    REFERENCES cash_register_sessions (tenant_id, id),
  CONSTRAINT payments_refund_shape CHECK (
    (kind = 'refund') = (refund_of IS NOT NULL AND reason IS NOT NULL)
    AND (kind = 'refund' OR reason IS NULL)
  ),
  CONSTRAINT payments_cash_session CHECK ((method = 'cash') = (session_id IS NOT NULL))
);

CREATE INDEX payments_tenant_invoice ON payments (tenant_id, invoice_id, at, id);
CREATE INDEX payments_tenant_session ON payments (tenant_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX payments_tenant_refund_of ON payments (tenant_id, refund_of) WHERE refund_of IS NOT NULL;

SELECT enable_tenant_rls('payments', 'SELECT, INSERT');

CREATE TABLE credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  invoice_id uuid NOT NULL,
  number text NOT NULL,
  fiscal_year text NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_notes_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT credit_notes_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoices (tenant_id, id)
);

CREATE INDEX credit_notes_tenant_invoice ON credit_notes (tenant_id, invoice_id, created_at, id);

SELECT enable_tenant_rls('credit_notes', 'SELECT, INSERT');

-- Never changed or removed, to the owner too.
CREATE FUNCTION billing_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is never changed or removed', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER payments_never_change BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION billing_never_change();
CREATE TRIGGER credit_notes_never_change BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION billing_never_change();

-- A charge keeps what it was posted as; its status, holder and flag are all that move.
CREATE FUNCTION charges_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.encounter_id <> OLD.encounter_id
    OR NEW.patient_id <> OLD.patient_id OR NEW.service_id IS DISTINCT FROM OLD.service_id
    OR NEW.source <> OLD.source OR NEW.source_ref <> OLD.source_ref
    OR NEW.description <> OLD.description OR NEW.quantity <> OLD.quantity
    OR NEW.unit_price_minor <> OLD.unit_price_minor OR NEW.posted_at <> OLD.posted_at THEN
    RAISE EXCEPTION 'A charge is never repriced or changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'A void charge stays void' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'invoiced' AND NEW.status = 'pending' AND NOT EXISTS (
    SELECT FROM invoices i
    WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.invoice_id AND i.status = 'void'
  ) THEN
    RAISE EXCEPTION 'An invoiced charge goes back only when its invoice is void'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'invoiced' AND NEW.status = 'invoiced' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'An invoiced charge stays on its invoice' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER charges_guard BEFORE UPDATE ON charges
  FOR EACH ROW EXECUTE FUNCTION charges_guard();

-- An invoice is changed while it is a draft; issued, it keeps its number, visit, patient and
-- total, and moves only between issued, paid and void as money and credit notes require.
CREATE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.encounter_id <> OLD.encounter_id
    OR NEW.patient_id <> OLD.patient_id OR NEW.currency <> OLD.currency
    OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'An invoice keeps its visit, patient and currency' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor <> OLD.total_minor
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year THEN
    RAISE EXCEPTION 'An issued invoice is never changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'draft' OR OLD.status = 'void' THEN
    RAISE EXCEPTION 'An issued invoice does not go back' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- Lines belong to a draft: an issued invoice's lines are never added to or taken away.
CREATE FUNCTION invoice_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  held text;
BEGIN
  SELECT status INTO held FROM invoices
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF held IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of an issued invoice are never changed' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

-- A closed session is final.
CREATE FUNCTION cash_register_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A closed register session is never changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.opened_by <> OLD.opened_by
    OR NEW.opened_at <> OLD.opened_at OR NEW.opening_minor <> OLD.opening_minor THEN
    RAISE EXCEPTION 'A register session keeps how it was opened' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cash_register_sessions_guard BEFORE UPDATE ON cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_register_sessions_guard();
