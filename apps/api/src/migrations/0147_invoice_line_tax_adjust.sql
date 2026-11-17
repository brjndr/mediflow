-- A split invoice (#1032) divides one charge's tax between two invoice lines. Each line's tax is
-- rounded on its own, so the two can differ from the tax on the whole charge by one minor unit;
-- `tax_adjust_minor` carries that remainder on one line so the invoices add up to the original.
-- Every other line keeps 0 and its tax is the number it always was.
ALTER TABLE invoice_lines DROP COLUMN tax_minor;

ALTER TABLE invoice_lines
  ADD COLUMN tax_adjust_minor bigint NOT NULL DEFAULT 0 CHECK (tax_adjust_minor BETWEEN -1 AND 1),
  ADD COLUMN tax_minor bigint GENERATED ALWAYS AS (
    round(
      (quantity::numeric * unit_price_minor
        - line_discount(quantity, unit_price_minor, discount_bp, discount_amount_minor)
        - bill_discount_minor) * tax_rate_bp / 10000
    )::bigint + tax_adjust_minor
  ) STORED;
