-- Whether a line of an invoice not void names a charge is asked before the charge is billed,
-- covered, voided or moved (#1255). Additive.
CREATE INDEX invoice_lines_tenant_charge ON invoice_lines (tenant_id, charge_id)
  WHERE charge_id IS NOT NULL;
