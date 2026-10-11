-- Plain columns for what the patient list orders by and what the duplicate check compares.
--
-- Under row-level security an index condition must use a leakproof operator. Comparing and
-- ordering text columns is; calling lower() inside the comparison is not. So the lower-case name
-- is stored, and the list is ordered and paged on those columns: a deep page then starts where
-- the cursor is instead of walking the index from the first row.
ALTER TABLE patients
  ADD COLUMN last_name_lower text GENERATED ALWAYS AS (lower(last_name)) STORED,
  ADD COLUMN first_name_lower text GENERATED ALWAYS AS (lower(first_name)) STORED,
  -- The last ten digits, so a number typed with a country code matches one typed without.
  ADD COLUMN phone_last10 text GENERATED ALWAYS AS (right(regexp_replace(phone, '\D', '', 'g'), 10)) STORED;

DROP INDEX patients_tenant_name;
CREATE INDEX patients_tenant_name ON patients (tenant_id, last_name_lower, first_name_lower, id);

DROP INDEX patients_tenant_phone;
CREATE INDEX patients_tenant_phone ON patients (tenant_id, phone_last10);
