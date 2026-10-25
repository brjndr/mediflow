-- Lab reports and result viewing (#92): a doctor's acknowledgement of a critical value, and a
-- patient's results read across their samples (the results tab and the trend of one test).

-- An acknowledgement names its result within the hospital.
ALTER TABLE lab_results ADD CONSTRAINT lab_results_tenant_id UNIQUE (tenant_id, id);

-- A doctor has seen a critical result. Append-only: never changed or removed. A correction is a
-- new result, so it is acknowledged again.
CREATE TABLE lab_result_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  result_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid NOT NULL,
  CONSTRAINT lab_result_acknowledgements_result FOREIGN KEY (tenant_id, result_id)
    REFERENCES lab_results (tenant_id, id)
);

-- Acknowledged once.
CREATE UNIQUE INDEX lab_result_acknowledgements_once
  ON lab_result_acknowledgements (tenant_id, result_id);

SELECT enable_tenant_rls('lab_result_acknowledgements', 'SELECT, INSERT');

-- Only a verified critical result is acknowledged; the handler also checks it is current.
CREATE FUNCTION lab_result_acknowledgements_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM lab_results
  WHERE tenant_id = NEW.tenant_id AND id = NEW.result_id
    AND status = 'verified' AND flag IN ('critical_low', 'critical_high')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a verified critical result is acknowledged' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_result_acknowledgements_guard_insert BEFORE INSERT
  ON lab_result_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION lab_result_acknowledgements_guard_insert();

-- A patient's results, read by patient and test (#92).
CREATE INDEX lab_results_tenant_patient ON lab_results (tenant_id, patient_id, lab_test_id);
