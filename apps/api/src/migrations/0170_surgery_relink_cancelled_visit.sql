-- A completed surgery left on a cancelled visit is linked to another (#1233), so its charges can
-- be posted there. For such a booking only the visit changes; a finished one stays closed
-- otherwise.
CREATE OR REPLACE FUNCTION ot_bookings_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['room_id', 'surgeon_id', 'starts_at', 'ends_at', 'status', 'started_at',
        'completed_at', 'cancelled_at', 'cancel_reason', 'version', 'updated_at', 'encounter_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['room_id', 'surgeon_id', 'starts_at', 'ends_at', 'status', 'started_at',
        'completed_at', 'cancelled_at', 'cancel_reason', 'version', 'updated_at', 'encounter_id']) THEN
    RAISE EXCEPTION 'Only the time, theatre, surgeon, visit and progress of a booking change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'completed' AND NEW.encounter_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['version', 'updated_at', 'encounter_id'])
       = (to_jsonb(OLD) - ARRAY['version', 'updated_at', 'encounter_id'])
     AND EXISTS (SELECT 1 FROM encounters e WHERE e.tenant_id = OLD.tenant_id
                   AND e.id = OLD.encounter_id AND e.status = 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'A finished booking is closed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status = 'completed')) THEN
    RAISE EXCEPTION 'A booking does not move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'scheduled' AND (
       NEW.room_id <> OLD.room_id OR NEW.surgeon_id <> OLD.surgeon_id
    OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at) THEN
    RAISE EXCEPTION 'Only a scheduled booking is moved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
