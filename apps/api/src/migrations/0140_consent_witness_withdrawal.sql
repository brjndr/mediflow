-- #989: witness signatures on a consent and withdrawing it (MR-09). Both are new rows with their
-- author and time, never an edit of the signed consent: the app role can only read and add. A
-- consent is withdrawn at most once.

ALTER TABLE patient_consents ADD CONSTRAINT patient_consents_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE consent_witnesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  consent_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  witness_name text NOT NULL CHECK (char_length(witness_name) BETWEEN 1 AND 200),
  witness_relation text CHECK (char_length(witness_relation) BETWEEN 1 AND 100),
  signature_method text NOT NULL CHECK (signature_method IN ('drawn', 'typed')),
  signature text CHECK (char_length(signature) BETWEEN 1 AND 20000 AND signature ~ '^[ML0-9 .,-]+$'),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_witnesses_consent FOREIGN KEY (tenant_id, consent_id)
    REFERENCES patient_consents (tenant_id, id),
  CONSTRAINT consent_witnesses_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT consent_witnesses_signature CHECK ((signature_method = 'drawn') = (signature IS NOT NULL))
);
CREATE INDEX consent_witnesses_consent_idx ON consent_witnesses (tenant_id, consent_id, recorded_at, id);
SELECT enable_tenant_rls('consent_witnesses', 'SELECT, INSERT');
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON consent_witnesses
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();

CREATE TABLE consent_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  consent_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  withdrawn_by uuid NOT NULL,
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_withdrawals_once UNIQUE (tenant_id, consent_id),
  CONSTRAINT consent_withdrawals_consent FOREIGN KEY (tenant_id, consent_id)
    REFERENCES patient_consents (tenant_id, id),
  CONSTRAINT consent_withdrawals_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);
SELECT enable_tenant_rls('consent_withdrawals', 'SELECT, INSERT');
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON consent_withdrawals
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
