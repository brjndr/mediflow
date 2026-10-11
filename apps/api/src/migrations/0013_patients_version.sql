-- A version number on every patient record, so two people editing the same record cannot
-- silently overwrite each other (P-04).
--
-- The number goes up by one on every update, in the trigger, so no code path can forget it. A
-- client that changes a record says which version it was looking at; if the record has moved on,
-- the change is refused and the client shows what changed.
ALTER TABLE patients ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE OR REPLACE FUNCTION patients_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.mrn <> OLD.mrn OR NEW.id <> OLD.id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A patient''s hospital, MRN and registration details cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  -- Whatever the statement set it to: the version is the database's to count.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
