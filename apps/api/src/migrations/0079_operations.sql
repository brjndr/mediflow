-- Hospital operations (#200): duty rosters, the blood bank, ambulances and bed cleaning tasks.
--
-- * A roster shift is a person on duty for a stretch of time; one person is never on two shifts
--   that overlap (an exclusion constraint). A cancelled shift stays as the record.
-- * A blood unit moves through a state machine the database enforces as well as the API
--   (collected -> testing -> available -> reserved -> issued -> transfused, or discarded or
--   expired on the way); every move is a row in the append-only blood_unit_events.
-- * An ambulance is available, on a trip or out of service; a trip goes requested -> dispatched
--   -> picked_up -> completed (or cancelled), and an ambulance has one live trip at a time.
-- * A cleaning task is the work of making a bed ready after a patient leaves it.

CREATE FUNCTION ops_touch() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'The hospital and id of a record cannot change' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- --- roster ----------------------------------------------------------------------------------

CREATE TABLE roster_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  user_id uuid NOT NULL,
  department_id uuid,
  shift_kind text NOT NULL CHECK (shift_kind IN ('morning', 'evening', 'night', 'day', 'on_call')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_shifts_in_order CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
  CONSTRAINT roster_shifts_member FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT roster_shifts_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT roster_shifts_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT roster_shifts_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled')
);
CREATE INDEX roster_shifts_tenant_start ON roster_shifts (tenant_id, starts_at, id);
CREATE INDEX roster_shifts_tenant_user ON roster_shifts (tenant_id, user_id, starts_at);

CREATE FUNCTION roster_shifts_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'scheduled'
     OR (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A shift is only cancelled, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER roster_shifts_touch BEFORE UPDATE ON roster_shifts
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER roster_shifts_guard BEFORE UPDATE ON roster_shifts
  FOR EACH ROW EXECUTE FUNCTION roster_shifts_guard_update();

SELECT enable_tenant_rls('roster_shifts', 'SELECT, INSERT, UPDATE');

-- --- blood bank ------------------------------------------------------------------------------

CREATE TABLE blood_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  unit_number text NOT NULL CHECK (char_length(unit_number) BETWEEN 1 AND 40),
  blood_group text NOT NULL CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  component text NOT NULL CHECK (component IN ('whole_blood', 'red_cells', 'plasma', 'platelets', 'cryo')),
  volume_ml integer NOT NULL CHECK (volume_ml BETWEEN 10 AND 1000),
  collected_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'collected' CHECK (status IN
    ('collected', 'testing', 'available', 'reserved', 'issued', 'transfused', 'discarded', 'expired')),
  patient_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_units_dates CHECK (expires_at > collected_at),
  -- The patient a unit is held for or went to is set exactly while the unit is with them.
  CONSTRAINT blood_units_patient CHECK (
    (status IN ('reserved', 'issued', 'transfused')) = (patient_id IS NOT NULL)
    OR status IN ('discarded', 'expired')
  ),
  CONSTRAINT blood_units_patient_fk FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT blood_units_number UNIQUE (tenant_id, unit_number),
  CONSTRAINT blood_units_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX blood_units_stock ON blood_units (tenant_id, status, blood_group, component, expires_at);
CREATE INDEX blood_units_patient_idx ON blood_units (tenant_id, patient_id) WHERE patient_id IS NOT NULL;

CREATE FUNCTION blood_units_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'patient_id', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'patient_id', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the status of a blood unit changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'A blood unit is not moved to the status it is in' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'collected' AND NEW.status IN ('testing', 'discarded'))
    OR (OLD.status = 'testing' AND NEW.status IN ('available', 'discarded'))
    OR (OLD.status = 'available' AND NEW.status IN ('reserved', 'discarded', 'expired'))
    OR (OLD.status = 'reserved' AND NEW.status IN ('available', 'issued', 'discarded', 'expired'))
    OR (OLD.status = 'issued' AND NEW.status IN ('transfused', 'discarded'))
  ) THEN
    RAISE EXCEPTION 'A blood unit cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  -- Blood past its date is not given out.
  IF NEW.status IN ('reserved', 'issued') AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'The blood unit has expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_units_touch BEFORE UPDATE ON blood_units
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER blood_units_guard BEFORE UPDATE ON blood_units
  FOR EACH ROW EXECUTE FUNCTION blood_units_guard();

SELECT enable_tenant_rls('blood_units', 'SELECT, INSERT, UPDATE');

-- Every move of a unit: append-only.
CREATE TABLE blood_unit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  blood_unit_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  patient_id uuid,
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_unit_events_unit FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES blood_units (tenant_id, id)
);
CREATE INDEX blood_unit_events_unit ON blood_unit_events (tenant_id, blood_unit_id, occurred_at, id);

SELECT enable_tenant_rls('blood_unit_events', 'SELECT, INSERT');

-- --- ambulances ------------------------------------------------------------------------------

CREATE TABLE ambulances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  registration text NOT NULL CHECK (char_length(registration) BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('basic', 'advanced', 'neonatal')),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'on_trip', 'out_of_service')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ambulances_registration UNIQUE (tenant_id, registration),
  CONSTRAINT ambulances_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX ambulances_tenant_status ON ambulances (tenant_id, status);
CREATE TRIGGER ambulances_touch BEFORE UPDATE ON ambulances
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
SELECT enable_tenant_rls('ambulances', 'SELECT, INSERT, UPDATE');

CREATE TABLE ambulance_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  patient_id uuid,
  ambulance_id uuid,
  pickup text NOT NULL CHECK (char_length(pickup) BETWEEN 1 AND 300),
  destination text NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN
    ('requested', 'dispatched', 'picked_up', 'completed', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL,
  dispatched_at timestamptz,
  picked_up_at timestamptz,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ambulance_trips_ambulance CHECK (
    (status = 'requested') = (ambulance_id IS NULL) OR status = 'cancelled'
  ),
  CONSTRAINT ambulance_trips_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT ambulance_trips_ambulance_fk FOREIGN KEY (tenant_id, ambulance_id)
    REFERENCES ambulances (tenant_id, id),
  CONSTRAINT ambulance_trips_tenant_id_id UNIQUE (tenant_id, id)
);
-- An ambulance has one trip under way at a time.
CREATE UNIQUE INDEX ambulance_trips_one_live ON ambulance_trips (tenant_id, ambulance_id)
  WHERE status IN ('dispatched', 'picked_up');
CREATE INDEX ambulance_trips_tenant_status ON ambulance_trips (tenant_id, status, requested_at DESC, id DESC);

CREATE FUNCTION ambulance_trips_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'ambulance_id', 'dispatched_at', 'picked_up_at', 'finished_at', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'ambulance_id', 'dispatched_at', 'picked_up_at', 'finished_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the progress of a trip changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    (OLD.status = 'requested' AND NEW.status IN ('dispatched', 'cancelled'))
    OR (OLD.status = 'dispatched' AND NEW.status IN ('picked_up', 'cancelled'))
    OR (OLD.status = 'picked_up' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'A trip cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ambulance_trips_touch BEFORE UPDATE ON ambulance_trips
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER ambulance_trips_guard BEFORE UPDATE ON ambulance_trips
  FOR EACH ROW EXECUTE FUNCTION ambulance_trips_guard();
SELECT enable_tenant_rls('ambulance_trips', 'SELECT, INSERT, UPDATE');

-- --- cleaning tasks --------------------------------------------------------------------------

CREATE TABLE cleaning_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  bed_id uuid NOT NULL,
  ward_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discharge', 'routine')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  assigned_to uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cleaning_tasks_bed FOREIGN KEY (tenant_id, bed_id) REFERENCES beds (tenant_id, id),
  CONSTRAINT cleaning_tasks_ward FOREIGN KEY (tenant_id, ward_id) REFERENCES wards (tenant_id, id),
  CONSTRAINT cleaning_tasks_assignee FOREIGN KEY (tenant_id, assigned_to)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT cleaning_tasks_tenant_id_id UNIQUE (tenant_id, id)
);
-- A bed has one task not yet finished.
CREATE UNIQUE INDEX cleaning_tasks_one_live ON cleaning_tasks (tenant_id, bed_id)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX cleaning_tasks_tenant_status ON cleaning_tasks (tenant_id, status, created_at, id);

CREATE FUNCTION cleaning_tasks_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'assigned_to', 'started_at', 'finished_at', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'assigned_to', 'started_at', 'finished_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the progress of a task changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    (OLD.status = 'open' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'A task cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cleaning_tasks_touch BEFORE UPDATE ON cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER cleaning_tasks_guard BEFORE UPDATE ON cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION cleaning_tasks_guard();
SELECT enable_tenant_rls('cleaning_tasks', 'SELECT, INSERT, UPDATE');
