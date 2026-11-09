-- A legal hold stops the retention sweep for one document or for all of a patient's documents
-- until someone releases it. A hold is never deleted: placing and releasing are both on the record.
CREATE TABLE document_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  -- Null: every document of the patient.
  document_id uuid,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  CONSTRAINT document_legal_holds_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT document_legal_holds_document FOREIGN KEY (tenant_id, document_id)
    REFERENCES patient_documents (tenant_id, id),
  CONSTRAINT document_legal_holds_released CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX document_legal_holds_active ON document_legal_holds (tenant_id, placed_at DESC, id DESC)
  WHERE released_at IS NULL;
CREATE INDEX document_legal_holds_patient ON document_legal_holds (tenant_id, patient_id)
  WHERE released_at IS NULL;
CREATE INDEX document_legal_holds_document ON document_legal_holds (tenant_id, document_id)
  WHERE released_at IS NULL AND document_id IS NOT NULL;

SELECT enable_tenant_rls('document_legal_holds', 'SELECT, INSERT');
GRANT UPDATE (released_by, released_at) ON document_legal_holds TO mediflow_app;

-- The sweep reads the holds across hospitals as the worker role.
CREATE POLICY worker_read ON document_legal_holds FOR SELECT TO mediflow_worker USING (true);
GRANT SELECT (tenant_id, patient_id, document_id, released_at) ON document_legal_holds TO mediflow_worker;
GRANT SELECT (patient_id), UPDATE (status, file_key, purged_at) ON patient_documents TO mediflow_worker;

-- The sweep writes one audit entry per purge into the owning hospital's log (append-only table).
CREATE POLICY worker_insert ON audit_log FOR INSERT TO mediflow_worker WITH CHECK (true);
GRANT INSERT ON audit_log TO mediflow_worker;
