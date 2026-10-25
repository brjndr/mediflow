-- A critical result is acknowledged only while it is the one released (#92): no later result of
-- its test and sample is verified. A verified correction replaces it, and the correction is the
-- one to acknowledge. The handler refuses the same (409 `not_acknowledgeable`).
CREATE OR REPLACE FUNCTION lab_result_acknowledgements_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM lab_results r
  WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.result_id
    AND r.status = 'verified' AND r.flag IN ('critical_low', 'critical_high')
    AND NOT EXISTS (
      SELECT FROM lab_results later
      WHERE later.tenant_id = r.tenant_id AND later.sample_id = r.sample_id
        AND later.lab_test_id = r.lab_test_id AND later.status = 'verified'
        AND (later.entered_at, later.id) > (r.entered_at, r.id)
    )
  FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the released critical result is acknowledged' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
