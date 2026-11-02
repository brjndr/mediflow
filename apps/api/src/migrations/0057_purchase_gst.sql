-- GST on purchase order and goods receipt lines (#427). The rate of a line, in basis points (1200
-- is 12%), is kept on the line; the tax is worked out from it on read, so the two cannot
-- disagree. Costs, and so batch costs, stay before tax. Existing lines have no tax (0).
-- The hospital's own GSTIN tells in-state from other-state supply (its first two digits are the
-- state); like the address, it is set by the platform path, and absent until then.

ALTER TABLE purchase_order_lines
  ADD COLUMN gst_rate_bp integer NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 10000);

ALTER TABLE goods_receipt_lines
  ADD COLUMN gst_rate_bp integer NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 10000);

ALTER TABLE tenants
  ADD COLUMN gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$');
