-- #566: signed consents and issued certificates (MR-02), the API behind the patient's Consents
-- tab. Both are append-only: the app role can only read and add, so a mistake is a new record.
-- A consent keeps the text it was signed with and the template version it came from; a
-- certificate keeps the layout it was issued under.

CREATE TABLE patient_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  procedure_name text NOT NULL CHECK (char_length(procedure_name) BETWEEN 1 AND 200),
  template_id uuid NOT NULL,
  template_version integer NOT NULL CHECK (template_version >= 1),
  -- The rich text document as it was signed, placeholders filled in. Never HTML.
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  signer_name text NOT NULL CHECK (char_length(signer_name) BETWEEN 1 AND 200),
  signer_role text NOT NULL CHECK (signer_role IN ('patient', 'guardian', 'representative')),
  signature_method text NOT NULL CHECK (signature_method IN ('drawn', 'typed')),
  -- SVG path data in a 300 by 150 box: only what the pad draws with.
  signature text CHECK (char_length(signature) BETWEEN 1 AND 20000 AND signature ~ '^[ML0-9 .,-]+$'),
  signed_by uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_consents_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_consents_template FOREIGN KEY (tenant_id, template_id, template_version)
    REFERENCES template_versions (tenant_id, template_id, version),
  CONSTRAINT patient_consents_signature CHECK ((signature_method = 'drawn') = (signature IS NOT NULL))
);

CREATE INDEX patient_consents_patient_idx
  ON patient_consents (tenant_id, patient_id, signed_at DESC, id DESC);

SELECT enable_tenant_rls('patient_consents', 'SELECT, INSERT');
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON patient_consents
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();

-- What a hospital changed in the fields of a kind of certificate. No row: the standard fields.
CREATE TABLE certificate_formats (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('medical', 'fitness', 'birth', 'death')),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
SELECT enable_tenant_rls('certificate_formats', 'SELECT, INSERT, UPDATE, DELETE');

-- The last number of each kind and year at a hospital; the row lock keeps numbers in order.
CREATE TABLE certificate_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('medical', 'fitness', 'birth', 'death')),
  year integer NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind, year)
);
SELECT enable_tenant_rls('certificate_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE patient_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('medical', 'fitness', 'birth', 'death')),
  number text NOT NULL CHECK (char_length(number) BETWEEN 1 AND 40),
  issued_on date NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  -- The fields of the format in force when it was issued.
  layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'array'),
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_certificates_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_certificates_number UNIQUE (tenant_id, number)
);

CREATE INDEX patient_certificates_patient_idx
  ON patient_certificates (tenant_id, patient_id, issued_at DESC, id DESC);

SELECT enable_tenant_rls('patient_certificates', 'SELECT, INSERT');
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON patient_certificates
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
