-- A charge left behind when a surgery is relinked to another visit (#906): flagged for the billing
-- desk to credit, apart from a stock return (`return_review`).
ALTER TABLE charges DROP CONSTRAINT charges_flag_check;
ALTER TABLE charges ADD CONSTRAINT charges_flag_check
  CHECK (flag IS NULL OR flag IN ('service_archived', 'no_price', 'return_review', 'package_covered', 'relink_review'));
