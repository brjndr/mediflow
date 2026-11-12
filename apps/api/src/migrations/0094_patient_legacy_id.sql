-- The registration number a patient had in the paper register or the system before this one
-- (#694). Additive and optional; unique within a hospital where set. The partial unique index
-- starts with tenant_id and serves the exact lookup in patient search.
ALTER TABLE patients ADD COLUMN legacy_id text CHECK (length(legacy_id) BETWEEN 1 AND 50);
CREATE UNIQUE INDEX patients_tenant_legacy_id ON patients (tenant_id, legacy_id)
  WHERE legacy_id IS NOT NULL;
