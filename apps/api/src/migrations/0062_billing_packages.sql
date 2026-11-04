-- Packages (#117): what a package service contains, and the charges it replaces.
--
-- A package is a service of category 'package' with its own price (a flat price, never the sum of
-- its parts). `package_items` says which services it includes, which are billed separately
-- anyway (excluded). Applying a package to a visit posts one charge of source 'package'; the
-- visit's pending charges for included services, and any posted for them afterwards, are voided
-- with a pointer to it (`package_charge_id`) and the flag 'package_covered', so they stay in the
-- ledger but are never billed twice.

CREATE TABLE package_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  package_service_id uuid NOT NULL,
  service_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('included', 'excluded')),
  CONSTRAINT package_items_package FOREIGN KEY (tenant_id, package_service_id)
    REFERENCES services (tenant_id, id),
  CONSTRAINT package_items_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  CONSTRAINT package_items_distinct CHECK (package_service_id <> service_id),
  CONSTRAINT package_items_once UNIQUE (tenant_id, package_service_id, service_id)
);

CREATE INDEX package_items_tenant_service ON package_items (tenant_id, service_id);

SELECT enable_tenant_rls('package_items', 'SELECT, INSERT, DELETE');

ALTER TABLE charges DROP CONSTRAINT charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
  CHECK (source IN ('service', 'order', 'dispense', 'bed', 'procedure', 'manual', 'package'));
ALTER TABLE charges DROP CONSTRAINT charges_flag_check;
ALTER TABLE charges ADD CONSTRAINT charges_flag_check
  CHECK (flag IS NULL OR flag IN ('service_archived', 'no_price', 'return_review', 'package_covered'));
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_source_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_source_check
  CHECK (source IN ('service', 'order', 'dispense', 'bed', 'procedure', 'manual', 'package'));

-- The package charge that covers this one; empty for every other charge.
ALTER TABLE charges ADD COLUMN package_charge_id uuid;
ALTER TABLE charges ADD CONSTRAINT charges_package FOREIGN KEY (tenant_id, package_charge_id)
  REFERENCES charges (tenant_id, id);
ALTER TABLE charges ADD CONSTRAINT charges_package_covered
  CHECK ((package_charge_id IS NOT NULL) = COALESCE(flag = 'package_covered', false));
CREATE INDEX charges_tenant_package ON charges (tenant_id, package_charge_id)
  WHERE package_charge_id IS NOT NULL;
