-- Cancelling an admission made by mistake (#573): a third final state next to discharged. The
-- admission keeps who cancelled it, when and why; the bed it held is released with the reason
-- 'cancelled'. Additive: new nullable columns and wider lists of allowed values.

ALTER TABLE admissions
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid,
  ADD COLUMN cancel_reason text;

ALTER TABLE admissions DROP CONSTRAINT admissions_status_check;
ALTER TABLE admissions ADD CONSTRAINT admissions_status_check
  CHECK (status IN ('admitted', 'discharged', 'cancelled'));

ALTER TABLE admissions ADD CONSTRAINT admissions_cancelled CHECK (
  (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (cancelled_at IS NULL) = (cancelled_by IS NULL)
  AND (cancelled_at IS NULL) = (cancel_reason IS NULL)
);

ALTER TABLE bed_assignments DROP CONSTRAINT bed_assignments_release_reason_check;
ALTER TABLE bed_assignments ADD CONSTRAINT bed_assignments_release_reason_check
  CHECK (release_reason IN ('transfer', 'discharge', 'cancelled'));

CREATE OR REPLACE FUNCTION admissions_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  moved text[] := ARRAY['status', 'discharged_at', 'discharged_by', 'discharge_type',
                        'cancelled_at', 'cancelled_by', 'cancel_reason', 'version', 'updated_at'];
BEGIN
  IF OLD.status <> 'admitted'
     OR (to_jsonb(NEW) - moved) IS DISTINCT FROM (to_jsonb(OLD) - moved) THEN
    RAISE EXCEPTION 'An admission is only discharged or cancelled, once' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
