-- Every version of every allergy list, append-only (#79): an allergy removed from the list stays
-- known, with who removed it and when. Written in the same transaction as the list itself, which
-- holds only the version in force.

CREATE TABLE allergy_list_versions (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('none', 'listed')),
  items jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, patient_id, version),
  CONSTRAINT allergy_list_versions_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);

-- No UPDATE or DELETE for the app role.
SELECT enable_tenant_rls('allergy_list_versions', 'SELECT, INSERT');
