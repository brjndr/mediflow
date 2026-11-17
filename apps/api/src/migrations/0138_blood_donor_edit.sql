-- A donor's name, date of birth, sex and phone can be corrected (#981). The blood group and the
-- donor number never change: units already carry the group.
CREATE OR REPLACE FUNCTION blood_donors_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['full_name', 'date_of_birth', 'sex', 'phone', 'deferred_until', 'deferred_permanent', 'deferral_reason', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['full_name', 'date_of_birth', 'sex', 'phone', 'deferred_until', 'deferred_permanent', 'deferral_reason', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'The blood group and number of a donor do not change' USING ERRCODE = '42501';
  END IF;
  -- A permanent deferral is never lifted.
  IF OLD.deferred_permanent AND NOT NEW.deferred_permanent THEN
    RAISE EXCEPTION 'A permanent deferral is not lifted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
