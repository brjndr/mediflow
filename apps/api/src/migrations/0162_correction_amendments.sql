-- #1179: an approved correction request (#556) is applied to its record as an amendment: a new,
-- append-only row that names the request, the target, what was asked, why, and who asked and
-- approved. The record's own rows are never edited. One amendment per request (a repeated event
-- changes nothing). `target_unavailable` says the target was gone or retired by the time the
-- approval was applied, so nothing was attached to it.
CREATE TABLE record_correction_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  request_id uuid NOT NULL UNIQUE REFERENCES record_correction_requests (id),
  patient_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('patient', 'encounter', 'document')),
  target_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'target_unavailable')),
  proposed text NOT NULL CHECK (char_length(proposed) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  requested_by uuid NOT NULL,
  approved_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correction_amendment_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);

CREATE INDEX record_correction_amendments_target ON record_correction_amendments
  (tenant_id, patient_id, target_kind, target_id);

SELECT enable_tenant_rls('record_correction_amendments', 'SELECT, INSERT');
