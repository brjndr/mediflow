-- Tax on invoices (#119). A hospital sets a rate for each tax class (the class every service and
-- drug already carries); a charge keeps the class it was posted with; a draft takes the rate in
-- effect when it is saved and an issued invoice keeps it for ever.
--
-- * `tax_rates`: one row for a class the hospital has set. A class with no row takes the default
--   rate (0, 5, 12 and 18 per cent), written in the API, so a new hospital needs no setup.
-- * `charges.tax_class`: null for work that carries no tax of its own (a dispensed medicine is
--   charged at its MRP, which already holds the tax).
-- * `invoice_lines.tax_rate_bp` is the rate the line was made with, in basis points; the tax is
--   worked out in the database, so every reader agrees, rounded half up per line.
-- * `invoices.total_minor` stays what is owed (lines plus tax), so payments, credit notes and the
--   register need no change; `tax_minor` is the part of it that is tax.

CREATE TABLE tax_rates (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  tax_class text NOT NULL CHECK (tax_class IN ('exempt', 'reduced', 'standard', 'higher')),
  rate_bp integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tax_class)
);

SELECT enable_tenant_rls('tax_rates', 'SELECT, INSERT, UPDATE');

ALTER TABLE charges
  ADD COLUMN tax_class text CHECK (tax_class IS NULL OR tax_class IN ('exempt', 'reduced', 'standard', 'higher'));

-- A line of a draft takes the tax class its charge was posted with, or the one typed in.
ALTER TABLE invoice_lines
  ADD COLUMN tax_class text CHECK (tax_class IS NULL OR tax_class IN ('exempt', 'reduced', 'standard', 'higher')),
  ADD COLUMN tax_rate_bp integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  ADD COLUMN tax_minor bigint GENERATED ALWAYS AS (
    round(quantity::numeric * unit_price_minor * tax_rate_bp / 10000)::bigint
  ) STORED;

ALTER TABLE invoices
  ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT invoices_tax_within CHECK (tax_minor <= total_minor);

-- A charge keeps its tax class as it keeps its price.
CREATE OR REPLACE FUNCTION charges_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.encounter_id <> OLD.encounter_id
    OR NEW.patient_id <> OLD.patient_id OR NEW.service_id IS DISTINCT FROM OLD.service_id
    OR NEW.source <> OLD.source OR NEW.source_ref <> OLD.source_ref
    OR NEW.description <> OLD.description OR NEW.quantity <> OLD.quantity
    OR NEW.unit_price_minor <> OLD.unit_price_minor OR NEW.posted_at <> OLD.posted_at
    OR NEW.tax_class IS DISTINCT FROM OLD.tax_class THEN
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

-- An issued invoice keeps its tax with its total.
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
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
    OR NEW.tax_minor <> OLD.tax_minor
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
