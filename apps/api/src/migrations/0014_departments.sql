-- Departments (BE-10): a hospital's own list (Cardiology, Paediatrics), which doctors and, later,
-- appointments and encounters refer to by id. Reference data: no patient data in it.

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  -- Stored, so uniqueness and ordering are plain comparisons that can use an index under
  -- row-level security (a function in the comparison could not).
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  -- Archived, never deleted: it stays on the records that name it and is no longer offered.
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One department of a name per hospital, whatever its capitals, archived or not.
  CONSTRAINT departments_name_taken UNIQUE (tenant_id, name_lower),
  -- So another table can refer to a department together with its hospital. A reference by id
  -- alone could name another hospital's department, and foreign keys are checked without
  -- row-level security.
  CONSTRAINT departments_tenant_id_id UNIQUE (tenant_id, id)
);

-- The list: a hospital's active (or archived) departments in name order.
CREATE INDEX departments_tenant_list ON departments (tenant_id, archived, name_lower, id);

-- No DELETE for the app role.
SELECT enable_tenant_rls('departments', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION departments_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A department''s hospital and identity cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  -- Whatever the statement set it to: the version is the database's to count.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER departments_guard_update BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION departments_guard_update();
