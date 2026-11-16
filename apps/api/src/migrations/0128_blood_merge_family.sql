-- A patient record and the records merged into it, directly or through another merge, leaving
-- out a merge that was undone (#936). Blood groups and cross-matches are append-only, so they stay
-- on the record they were written for and are read through the survivor.
CREATE FUNCTION merged_family(root uuid) RETURNS TABLE (id uuid)
  LANGUAGE sql STABLE
  AS $$
  WITH RECURSIVE fam (id, depth) AS (
    SELECT root, 0
    UNION ALL
    SELECT m.source_patient_id, f.depth + 1
    FROM fam f JOIN patient_merges m ON m.target_patient_id = f.id AND m.unmerged_at IS NULL
    WHERE f.depth < 20
  )
  SELECT fam.id FROM fam ORDER BY fam.depth
$$;
GRANT EXECUTE ON FUNCTION merged_family(uuid) TO mediflow_app;

-- The unit guard of 0126, with one change: a cross-match made for a record merged into the
-- patient counts as the patient's own.
CREATE OR REPLACE FUNCTION blood_units_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'patient_id', 'screening_status', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'patient_id', 'screening_status', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the status of a blood unit changes' USING ERRCODE = '42501';
  END IF;
  -- Only a screening (its own trigger, one level down) says a unit is cleared.
  IF NEW.screening_status IS DISTINCT FROM OLD.screening_status AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Only a screening sets the screening status' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status AND NEW.screening_status IS NOT DISTINCT FROM OLD.screening_status THEN
    RAISE EXCEPTION 'A blood unit is not moved to the status it is in' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'collected' AND NEW.status IN ('testing', 'discarded'))
    OR (OLD.status = 'testing' AND NEW.status IN ('available', 'discarded'))
    OR (OLD.status = 'available' AND NEW.status IN ('reserved', 'discarded', 'expired'))
    OR (OLD.status = 'reserved' AND NEW.status IN ('available', 'issued', 'discarded', 'expired'))
    OR (OLD.status = 'issued' AND NEW.status IN ('transfused', 'discarded'))
  ) THEN
    RAISE EXCEPTION 'A blood unit cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'available' AND OLD.status = 'testing' AND NEW.screening_status <> 'cleared' THEN
    RAISE EXCEPTION 'A blood unit is not cleared by screening' USING ERRCODE = '23514';
  END IF;
  -- Blood past its date is not given out.
  IF NEW.status IN ('reserved', 'issued') AND NEW.status <> OLD.status AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'The blood unit has expired' USING ERRCODE = '23514';
  END IF;
  -- Reserving needs a compatible cross-match of this unit and patient, made in the last 72 hours.
  IF NEW.status = 'reserved' AND OLD.status <> 'reserved' AND COALESCE((
    SELECT c.result = 'compatible' AND c.valid_until > now() FROM blood_crossmatches c
    WHERE c.tenant_id = NEW.tenant_id AND c.blood_unit_id = NEW.id
      AND c.patient_id IN (SELECT id FROM merged_family(NEW.patient_id))
    ORDER BY c.performed_at DESC, c.id DESC LIMIT 1
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'A blood unit is reserved only after a valid cross-match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
