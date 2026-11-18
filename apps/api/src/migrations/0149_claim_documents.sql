-- The files of a claim's packet (#976): documents already on the patient's record, attached to a
-- claim. The claim keeps no copy; the file stays under the documents module's retention, scan and
-- legal holds. Attached and detached by the claims desk (a detach deletes the link, never the file).
CREATE TABLE claim_documents (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  claim_id uuid NOT NULL,
  document_id uuid NOT NULL,
  attached_by uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, claim_id, document_id),
  CONSTRAINT claim_documents_claim FOREIGN KEY (tenant_id, claim_id) REFERENCES claims (tenant_id, id),
  CONSTRAINT claim_documents_document FOREIGN KEY (tenant_id, document_id)
    REFERENCES patient_documents (tenant_id, id)
);
CREATE INDEX claim_documents_document ON claim_documents (tenant_id, document_id);

SELECT enable_tenant_rls('claim_documents', 'SELECT, INSERT, DELETE');
