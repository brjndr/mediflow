-- #556: a correction to a patient's record is a request with its author and reason, decided by a
-- second person, never a silent edit. Approving records the decision and announces it; the module
-- that owns the record applies the change through its own amendment flow.
CREATE TABLE record_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('patient', 'encounter', 'document')),
  -- The encounter or document; null when the whole patient record is meant.
  target_id uuid,
  proposed text NOT NULL CHECK (char_length(proposed) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (char_length(decision_reason) BETWEEN 1 AND 300),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT correction_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT correction_target CHECK ((target_kind = 'patient') = (target_id IS NULL)),
  CONSTRAINT correction_decided CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND decision_reason IS NOT NULL AND decided_by <> requested_by)
  )
);

CREATE INDEX record_correction_patient ON record_correction_requests
  (tenant_id, patient_id, requested_at DESC, id DESC);
CREATE INDEX record_correction_status ON record_correction_requests
  (tenant_id, status, requested_at DESC, id DESC);

SELECT enable_tenant_rls('record_correction_requests', 'SELECT, INSERT');
GRANT UPDATE (status, decided_by, decided_at, decision_reason, version)
  ON record_correction_requests TO mediflow_app;

-- A request is decided once: only a pending one may change, and only its decision.
CREATE FUNCTION record_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided correction request cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER record_correction_guard BEFORE UPDATE ON record_correction_requests
  FOR EACH ROW EXECUTE FUNCTION record_correction_guard();

CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON record_correction_requests
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
