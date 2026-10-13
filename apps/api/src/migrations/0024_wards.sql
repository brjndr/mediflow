-- Wards, rooms and beds (BE-17d): the wards of a hospital, the rooms of each and the beds of each
-- room, and the bed categories that decide what a day in a bed is charged as. Reference data: a
-- bed carries its status and holds nothing about a patient. Who is in a bed is the admission
-- module's (R2), which also sets a bed occupied and being cleaned.

-- A class of bed (general ward, private room, intensive care). The tariff is here, as a link to
-- a bed-day service of the price catalog, never a price typed on a bed.
CREATE TABLE bed_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  -- Stored, so uniqueness and ordering are plain comparisons on a column.
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  -- Together with the hospital: foreign keys are checked without row-level security.
  service_id uuid,
  -- Archived, never deleted: it stays on the beds, and later the stays, that name it.
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bed_categories_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  -- One category of a name per hospital, whatever its capitals, archived or not.
  CONSTRAINT bed_categories_name_taken UNIQUE (tenant_id, name_lower),
  CONSTRAINT bed_categories_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX bed_categories_tenant_list ON bed_categories (tenant_id, archived, name_lower, id);

SELECT enable_tenant_rls('bed_categories', 'SELECT, INSERT, UPDATE');

CREATE TABLE wards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Short and unique in the hospital. Never changes (the trigger below).
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(code) <= 20),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  -- Where it is: a floor, a block, a wing.
  floor text CHECK (floor IS NULL OR (floor = btrim(floor) AND length(floor) BETWEEN 1 AND 50)),
  department_id uuid,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  code_lower text GENERATED ALWAYS AS (lower(code)) STORED,
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  search_text text GENERATED ALWAYS AS (lower(code) || ' ' || lower(name)) STORED,
  CONSTRAINT wards_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  -- One ward of a code per hospital, whatever its capitals, archived or not.
  CONSTRAINT wards_code_taken UNIQUE (tenant_id, code_lower),
  CONSTRAINT wards_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX wards_tenant_list ON wards (tenant_id, archived, name_lower, id);

SELECT enable_tenant_rls('wards', 'SELECT, INSERT, UPDATE');

-- Every bed is in a room: an open ward is one room with many beds.
CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  ward_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 50),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_ward FOREIGN KEY (tenant_id, ward_id) REFERENCES wards (tenant_id, id),
  -- A room name is one in its ward, whatever its capitals, archived or not.
  CONSTRAINT rooms_name_taken UNIQUE (tenant_id, ward_id, name_lower),
  -- So a bed refers to its room together with the room's ward: a bed is never in a room of
  -- another ward.
  CONSTRAINT rooms_tenant_ward_id UNIQUE (tenant_id, ward_id, id)
);

SELECT enable_tenant_rls('rooms', 'SELECT, INSERT, UPDATE');

CREATE TABLE beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  ward_id uuid NOT NULL,
  room_id uuid NOT NULL,
  -- What is written on the bed.
  number text NOT NULL CHECK (number = btrim(number) AND length(number) BETWEEN 1 AND 20),
  number_lower text GENERATED ALWAYS AS (lower(number)) STORED,
  bed_category_id uuid NOT NULL,
  -- available: free to take a patient. occupied: a patient is admitted to it (admissions).
  -- cleaning: being made ready after a discharge (housekeeping). blocked: out of use, with a reason.
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'occupied', 'cleaning', 'blocked')),
  -- A reason from a list: free text is where something about a patient gets written.
  blocked_reason text
    CHECK (blocked_reason IN ('repair', 'maintenance', 'deep_cleaning', 'reserved', 'other')),
  -- A few words more, about the bed. Free text, so it is never logged or put in an event.
  blocked_note text
    CHECK (blocked_note IS NULL
      OR (blocked_note = btrim(blocked_note) AND length(blocked_note) BETWEEN 1 AND 100)),
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beds_room FOREIGN KEY (tenant_id, ward_id, room_id)
    REFERENCES rooms (tenant_id, ward_id, id),
  CONSTRAINT beds_category FOREIGN KEY (tenant_id, bed_category_id)
    REFERENCES bed_categories (tenant_id, id),
  -- A bed number is one in its ward, whatever its capitals, archived or not.
  CONSTRAINT beds_number_taken UNIQUE (tenant_id, ward_id, number_lower),
  -- A blocked bed has a reason, and only a blocked bed has one or a note.
  CONSTRAINT beds_blocked_has_a_reason CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CONSTRAINT beds_note_of_a_block CHECK (blocked_note IS NULL OR status = 'blocked'),
  -- A bed a patient is in is never archived, whatever archives it: the bed, its room.
  CONSTRAINT beds_occupied_not_archived CHECK (NOT (archived AND status = 'occupied'))
);

-- The beds of a room, and the beds that have a category.
CREATE INDEX beds_tenant_room ON beds (tenant_id, room_id);
CREATE INDEX beds_tenant_category ON beds (tenant_id, bed_category_id);

SELECT enable_tenant_rls('beds', 'SELECT, INSERT, UPDATE');

-- The version of each is the database's to count, and what makes each the one it is never changes.
CREATE FUNCTION bed_categories_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A bed category''s hospital and identity cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bed_categories_guard_update BEFORE UPDATE ON bed_categories
  FOR EACH ROW EXECUTE FUNCTION bed_categories_guard_update();

CREATE FUNCTION wards_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'A ward''s hospital, identity and code cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  -- A ward with a patient in one of its beds is not archived.
  IF NEW.archived AND NOT OLD.archived AND EXISTS (
    SELECT FROM beds
    WHERE tenant_id = NEW.tenant_id AND ward_id = NEW.id AND status = 'occupied' AND NOT archived
  ) THEN
    RAISE EXCEPTION 'A ward with an occupied bed is not archived' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wards_guard_update BEFORE UPDATE ON wards
  FOR EACH ROW EXECUTE FUNCTION wards_guard_update();

CREATE FUNCTION rooms_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.ward_id <> OLD.ward_id THEN
    RAISE EXCEPTION 'A room''s hospital, identity and ward cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rooms_guard_update BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_guard_update();

CREATE FUNCTION beds_guard_update() RETURNS trigger
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
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER beds_guard_update BEFORE UPDATE ON beds
  FOR EACH ROW EXECUTE FUNCTION beds_guard_update();
