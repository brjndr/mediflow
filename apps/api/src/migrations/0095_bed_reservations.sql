-- Bed reservations (#582): a bed held for a patient who is not in it yet (a planned admission),
-- until a time. What the database guarantees: a bed has at most one reservation open at a time and
-- a patient at most one; a reservation is only ever released, once, with how it ended. A reservation
-- past its time is dead the moment it passes (readers compare expires_at with now()); the row is
-- marked `expired` the next time someone reserves that bed.

CREATE TABLE bed_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  bed_id uuid NOT NULL,
  ward_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  released_at timestamptz,
  released_by uuid,
  release_reason text CHECK (release_reason IN ('cancelled', 'fulfilled', 'expired')),
  CONSTRAINT bed_reservations_released CHECK (
    (released_at IS NULL) = (release_reason IS NULL)
    AND (release_reason = 'expired' OR (released_at IS NULL) = (released_by IS NULL))
  ),
  CONSTRAINT bed_reservations_expiry CHECK (expires_at > created_at),
  CONSTRAINT bed_reservations_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT bed_reservations_bed FOREIGN KEY (tenant_id, bed_id) REFERENCES beds (tenant_id, id),
  CONSTRAINT bed_reservations_ward FOREIGN KEY (tenant_id, ward_id) REFERENCES wards (tenant_id, id),
  CONSTRAINT bed_reservations_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX bed_reservations_one_per_bed ON bed_reservations (tenant_id, bed_id)
  WHERE released_at IS NULL;
CREATE UNIQUE INDEX bed_reservations_one_per_patient ON bed_reservations (tenant_id, patient_id)
  WHERE released_at IS NULL;

SELECT enable_tenant_rls('bed_reservations', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION bed_reservations_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.released_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by', 'release_reason'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['released_at', 'released_by', 'release_reason']) THEN
    RAISE EXCEPTION 'A bed reservation is only released, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bed_reservations_guard_update BEFORE UPDATE ON bed_reservations
  FOR EACH ROW EXECUTE FUNCTION bed_reservations_guard_update();
