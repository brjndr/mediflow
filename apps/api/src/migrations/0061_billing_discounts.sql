-- Discounts on invoices (#116). A line may carry a discount (a percentage or an amount) and the
-- bill as a whole may carry one; both come off before tax. A reason is a fixed code (never free
-- text, so an audit entry or an event never holds a sentence about a patient).
--
-- * `invoice_lines.discount_bp` / `discount_amount_minor`: what the desk typed for the line, one
--   or the other. `discount_minor` is worked out here, so every reader agrees.
-- * `invoice_lines.bill_discount_minor`: this line's share of the bill discount, spread by the
--   API in proportion to what each line costs after its own discount (largest remainder, so the
--   shares add up exactly).
-- * Tax is worked out on what is left after both discounts, half up, per line.
-- * `invoices.discount_status`: `none` (no discount, or one within the hospital's limit),
--   `pending` (above the limit and waiting for a second person) or `approved`. An invoice that
--   is pending cannot leave draft, here as well as in the API.
-- * `billing_settings.discount_limit_bp`: the most a bill may be discounted without approval, as
--   a share of the bill before tax in basis points; 500 is 5%.

CREATE FUNCTION line_discount(quantity integer, unit_price_minor bigint, bp integer, amount bigint)
  RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN bp IS NOT NULL THEN round(quantity::numeric * unit_price_minor * bp / 10000)::bigint
      ELSE coalesce(amount, 0)
    END
  $$;

CREATE TABLE billing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  discount_limit_bp integer NOT NULL DEFAULT 500 CHECK (discount_limit_bp BETWEEN 0 AND 10000),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT enable_tenant_rls('billing_settings', 'SELECT, INSERT, UPDATE');

-- tax_minor now follows what is left after the discounts, so it is made again; for a line with
-- no discount it is the number it always was.
ALTER TABLE invoice_lines DROP COLUMN tax_minor;

ALTER TABLE invoice_lines
  ADD COLUMN discount_bp integer CHECK (discount_bp IS NULL OR discount_bp BETWEEN 1 AND 10000),
  ADD COLUMN discount_amount_minor bigint
    CHECK (discount_amount_minor IS NULL OR discount_amount_minor BETWEEN 1 AND 9007199254740991),
  ADD COLUMN discount_reason text CHECK (discount_reason IS NULL OR discount_reason IN
    ('staff', 'charity', 'senior_citizen', 'goodwill', 'correction', 'other')),
  ADD COLUMN bill_discount_minor bigint NOT NULL DEFAULT 0 CHECK (bill_discount_minor >= 0),
  ADD COLUMN discount_minor bigint GENERATED ALWAYS AS (
    line_discount(quantity, unit_price_minor, discount_bp, discount_amount_minor)
  ) STORED,
  ADD CONSTRAINT invoice_lines_one_discount CHECK (
    NOT (discount_bp IS NOT NULL AND discount_amount_minor IS NOT NULL)
    AND ((discount_bp IS NULL AND discount_amount_minor IS NULL) = (discount_reason IS NULL))
  ),
  ADD CONSTRAINT invoice_lines_discount_within CHECK (
    line_discount(quantity, unit_price_minor, discount_bp, discount_amount_minor)
      + bill_discount_minor <= quantity * unit_price_minor
  );

ALTER TABLE invoice_lines
  ADD COLUMN tax_minor bigint GENERATED ALWAYS AS (
    round(
      (quantity::numeric * unit_price_minor
        - line_discount(quantity, unit_price_minor, discount_bp, discount_amount_minor)
        - bill_discount_minor) * tax_rate_bp / 10000
    )::bigint
  ) STORED;

ALTER TABLE invoices
  ADD COLUMN bill_discount_bp integer
    CHECK (bill_discount_bp IS NULL OR bill_discount_bp BETWEEN 1 AND 10000),
  ADD COLUMN bill_discount_amount_minor bigint
    CHECK (bill_discount_amount_minor IS NULL OR bill_discount_amount_minor >= 1),
  ADD COLUMN bill_discount_reason text CHECK (bill_discount_reason IS NULL OR bill_discount_reason IN
    ('staff', 'charity', 'senior_citizen', 'goodwill', 'correction', 'other')),
  -- Line discounts and the bill discount together, before tax.
  ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0
    CHECK (discount_minor BETWEEN 0 AND 9007199254740991),
  ADD COLUMN discount_status text NOT NULL DEFAULT 'none'
    CHECK (discount_status IN ('none', 'pending', 'approved')),
  -- Who last changed the discount, who approved it and the amount they approved.
  ADD COLUMN discount_applied_by uuid,
  ADD COLUMN discount_approved_by uuid,
  ADD COLUMN discount_approved_at timestamptz,
  ADD COLUMN discount_approved_minor bigint,
  -- The bill before discount and tax that the approver saw: an approval stands for the amount and
  -- for the bill it was given on.
  ADD COLUMN discount_approved_gross_minor bigint,
  ADD CONSTRAINT invoices_one_bill_discount CHECK (
    NOT (bill_discount_bp IS NOT NULL AND bill_discount_amount_minor IS NOT NULL)
    AND ((bill_discount_bp IS NULL AND bill_discount_amount_minor IS NULL)
      = (bill_discount_reason IS NULL))
  ),
  ADD CONSTRAINT invoices_approval CHECK (
    (discount_status = 'approved') = (discount_approved_by IS NOT NULL
      AND discount_approved_at IS NOT NULL AND discount_approved_minor IS NOT NULL
      AND discount_approved_gross_minor IS NOT NULL)
  );

-- An issued invoice keeps its discount with its total, and one waiting for approval never leaves
-- draft.
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
    IF NEW.status <> 'draft' AND NEW.discount_status = 'pending' THEN
      RAISE EXCEPTION 'A discount above the limit is approved before the invoice is issued'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor <> OLD.total_minor
    OR NEW.tax_minor <> OLD.tax_minor OR NEW.discount_minor <> OLD.discount_minor
    OR NEW.discount_status IS DISTINCT FROM OLD.discount_status
    OR NEW.bill_discount_bp IS DISTINCT FROM OLD.bill_discount_bp
    OR NEW.bill_discount_amount_minor IS DISTINCT FROM OLD.bill_discount_amount_minor
    OR NEW.bill_discount_reason IS DISTINCT FROM OLD.bill_discount_reason
    OR NEW.discount_applied_by IS DISTINCT FROM OLD.discount_applied_by
    OR NEW.discount_approved_by IS DISTINCT FROM OLD.discount_approved_by
    OR NEW.discount_approved_at IS DISTINCT FROM OLD.discount_approved_at
    OR NEW.discount_approved_minor IS DISTINCT FROM OLD.discount_approved_minor
    OR NEW.discount_approved_gross_minor IS DISTINCT FROM OLD.discount_approved_gross_minor
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
