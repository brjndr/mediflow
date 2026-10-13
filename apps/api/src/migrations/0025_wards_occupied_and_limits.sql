-- Wards, after review of 0024 (BE-17d).

-- So admissions and bed assignments can refer to a bed, and anything to a room, together with its
-- hospital (see departments, migration 0014).
ALTER TABLE rooms ADD CONSTRAINT rooms_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE beds ADD CONSTRAINT beds_tenant_id_id UNIQUE (tenant_id, id);

-- 0024 refused to archive a ward with an occupied bed by reading the beds, which does not see a
-- bed being occupied by a request that has not finished: both could go through. The beds of the
-- ward are now held while it is archived, so the two take their turn, the ward first and then its
-- beds, as everywhere.
CREATE OR REPLACE FUNCTION wards_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'A ward''s hospital, identity and code cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  -- A ward with a patient in one of its beds is not archived.
  IF NEW.archived AND NOT OLD.archived THEN
    PERFORM 1 FROM beds
    WHERE tenant_id = NEW.tenant_id AND ward_id = NEW.id AND NOT archived
    FOR UPDATE;
    IF EXISTS (
      SELECT FROM beds
      WHERE tenant_id = NEW.tenant_id AND ward_id = NEW.id AND status = 'occupied' AND NOT archived
    ) THEN
      RAISE EXCEPTION 'A ward with an occupied bed is not archived' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- A room is archived with its beds: none of them is left in use in a room that is not.
CREATE OR REPLACE FUNCTION rooms_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.ward_id <> OLD.ward_id THEN
    RAISE EXCEPTION 'A room''s hospital, identity and ward cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.archived AND NOT OLD.archived AND EXISTS (
    SELECT FROM beds WHERE tenant_id = NEW.tenant_id AND room_id = NEW.id AND NOT archived
  ) THEN
    RAISE EXCEPTION 'A room is archived with its beds' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- And from the bed's side: a patient is not put in a bed of an archived ward or room, and a bed
-- does not come back into an archived room. A read, not a lock: the ward is held first by
-- whoever changes it, and a bed that held its ward would wait the other way round.
CREATE OR REPLACE FUNCTION beds_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.ward_id <> OLD.ward_id OR NEW.room_id <> OLD.room_id THEN
    RAISE EXCEPTION 'A bed''s hospital, identity, ward and room cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  -- Archiving never changes a bed's status, and nothing happens to a bed while it is archived:
  -- one being cleaned or blocked is still that when it is restored.
  IF NEW.status <> OLD.status AND (NEW.archived OR OLD.archived) THEN
    RAISE EXCEPTION 'The status of an archived bed does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'occupied' AND OLD.status <> 'occupied' AND EXISTS (
    SELECT FROM wards w
    JOIN rooms r ON r.tenant_id = w.tenant_id AND r.ward_id = w.id
    WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.ward_id AND r.id = NEW.room_id
      AND (w.archived OR r.archived)
  ) THEN
    RAISE EXCEPTION 'A bed of an archived ward or room takes no patient' USING ERRCODE = '23514';
  END IF;
  IF OLD.archived AND NOT NEW.archived AND EXISTS (
    SELECT FROM rooms WHERE tenant_id = NEW.tenant_id AND id = NEW.room_id AND archived
  ) THEN
    RAISE EXCEPTION 'A bed does not come back into an archived room' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
