-- Outsourced tests (#94): a received sample sent to a partner laboratory, and its report back.
-- A sample goes out at most once: one the partner cannot test is rejected and collected again,
-- as a new sample. Results are entered from the partner's report once it is back.
ALTER TABLE lab_samples
  -- Plain text, tidied by the API.
  ADD COLUMN partner_lab text CHECK (partner_lab IS NULL OR length(partner_lab) BETWEEN 1 AND 100),
  -- The partner's own number for the sample or its report, when it gives one.
  ADD COLUMN partner_ref text CHECK (partner_ref IS NULL OR length(partner_ref) BETWEEN 1 AND 50),
  ADD COLUMN sent_out_at timestamptz,
  ADD COLUMN sent_out_by uuid,
  ADD COLUMN returned_at timestamptz,
  ADD COLUMN returned_by uuid,
  ADD CONSTRAINT lab_samples_sent_out CHECK (
    (sent_out_at IS NULL) = (sent_out_by IS NULL)
    AND (sent_out_at IS NULL) = (partner_lab IS NULL)
    AND (sent_out_at IS NOT NULL OR partner_ref IS NULL)
  ),
  ADD CONSTRAINT lab_samples_returned CHECK (
    (returned_at IS NULL) = (returned_by IS NULL)
    AND (returned_at IS NULL OR sent_out_at IS NOT NULL)
  );

-- As 0042's, and: a received sample with no results is sent out once, and its report comes back
-- once; neither is ever changed afterwards.
CREATE OR REPLACE FUNCTION lab_samples_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id
     OR NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.lab_test_id <> OLD.lab_test_id OR NEW.accession_id <> OLD.accession_id
     OR NEW.sample_type <> OLD.sample_type OR NEW.container IS DISTINCT FROM OLD.container
     OR NEW.collected_at <> OLD.collected_at OR NEW.collected_by <> OLD.collected_by THEN
    RAISE EXCEPTION 'What a sample is of, and its collection, never change'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.received_at IS NOT NULL AND (NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.received_by IS DISTINCT FROM OLD.received_by) THEN
    RAISE EXCEPTION 'A sample is received once' USING ERRCODE = '42501';
  END IF;
  IF OLD.sent_out_at IS NOT NULL AND (NEW.sent_out_at IS DISTINCT FROM OLD.sent_out_at
     OR NEW.sent_out_by IS DISTINCT FROM OLD.sent_out_by
     OR NEW.partner_lab IS DISTINCT FROM OLD.partner_lab
     OR NEW.partner_ref IS DISTINCT FROM OLD.partner_ref) THEN
    RAISE EXCEPTION 'A sample is sent out once' USING ERRCODE = '42501';
  END IF;
  IF OLD.returned_at IS NOT NULL AND (NEW.returned_at IS DISTINCT FROM OLD.returned_at
     OR NEW.returned_by IS DISTINCT FROM OLD.returned_by) THEN
    RAISE EXCEPTION 'A partner report comes back once' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN
    -- Staying received is sending out, or the partner's report coming back: one at a time.
    IF NOT (OLD.status = 'received' AND (
         (OLD.sent_out_at IS NULL AND NEW.sent_out_at IS NOT NULL AND NEW.returned_at IS NULL)
      OR (OLD.sent_out_at IS NOT NULL AND OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL)
    )) THEN
      RAISE EXCEPTION 'A sample does not move from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
    IF OLD.sent_out_at IS NULL AND EXISTS (
      SELECT FROM lab_results WHERE tenant_id = NEW.tenant_id AND sample_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'A sample with results is not sent out' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT (
       (OLD.status = 'collected' AND NEW.status IN ('received', 'rejected'))
    OR (OLD.status = 'received' AND NEW.status = 'rejected')
  ) OR NEW.sent_out_at IS DISTINCT FROM OLD.sent_out_at
    OR NEW.returned_at IS DISTINCT FROM OLD.returned_at THEN
    RAISE EXCEPTION 'A sample does not move from % to %', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'rejected' AND EXISTS (
    SELECT FROM lab_results WHERE tenant_id = NEW.tenant_id AND sample_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A sample with results is not rejected' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- As 0042's, and not while the sample is with a partner laboratory: its results are entered
-- from the partner's report once it is back.
CREATE OR REPLACE FUNCTION lab_results_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM lab_samples
  WHERE tenant_id = NEW.tenant_id AND id = NEW.sample_id AND status = 'received'
    AND (sent_out_at IS NULL OR returned_at IS NOT NULL)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Results are entered for a received sample, not one with a partner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
