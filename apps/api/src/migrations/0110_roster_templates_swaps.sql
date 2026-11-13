-- Shift templates, repeating weeks and swaps for the duty roster (#592).
--
-- * A hospital keeps its own shift templates: a name, the kind of shift, the hours on the
--   hospital's clock ('HH:MM', an end at or before the start runs into the next day) and an
--   optional department. A template is retired (`active = false`), never deleted, so the list
--   keeps its history; its hours only ever fill a form, the shifts it makes hold instants.
-- * A shift handed over or exchanged (a swap) is a new shift for the new person, pointing at the
--   shift it replaces; the old one is cancelled as before. The pointer is set on insert only.

CREATE TABLE roster_shift_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  shift_kind text NOT NULL CHECK (shift_kind IN ('morning', 'evening', 'night', 'day', 'on_call')),
  start_time text NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text NOT NULL CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  department_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_templates_hours CHECK (start_time <> end_time),
  CONSTRAINT roster_templates_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT roster_templates_tenant_id_id UNIQUE (tenant_id, id)
);
-- One live template of a name in a hospital.
CREATE UNIQUE INDEX roster_templates_name ON roster_shift_templates (tenant_id, lower(name))
  WHERE active;

CREATE FUNCTION roster_templates_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.active = false
     OR NEW.active = true
     OR (to_jsonb(NEW) - ARRAY['active', 'version', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A shift template is only retired, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER roster_templates_touch BEFORE UPDATE ON roster_shift_templates
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER roster_templates_guard BEFORE UPDATE ON roster_shift_templates
  FOR EACH ROW EXECUTE FUNCTION roster_templates_guard_update();

SELECT enable_tenant_rls('roster_shift_templates', 'SELECT, INSERT, UPDATE');

ALTER TABLE roster_shifts ADD COLUMN replaces_shift_id uuid;
ALTER TABLE roster_shifts ADD CONSTRAINT roster_shifts_replaces FOREIGN KEY (tenant_id, replaces_shift_id)
  REFERENCES roster_shifts (tenant_id, id);
