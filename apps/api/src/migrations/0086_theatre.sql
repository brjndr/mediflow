-- Operation theatre (BE-27, #180).
--
-- * A theatre (room) is booked for a surgeon and a patient over a time range. Exclusion
--   constraints on the half-open range hold a theatre, a surgeon and a patient to one live
--   booking at a time (scheduled or in progress), so simultaneous requests cannot overlap: the
--   database decides, never the client or a check in code.
-- * A booking moves scheduled -> in_progress -> completed, or scheduled -> cancelled. Completed
--   and cancelled are final; only a scheduled booking can be moved to another time or room.
-- * Consumables used in a surgery are rows that never change; each takes stock out through the
--   inventory ledger in the same transaction (new ledger source `theatre`, reason `theatre_use`).

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense', 'sale', 'sale_return', 'receipt', 'purchase_return',
    'dispense_return', 'issue', 'theatre'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return', 'receipt', 'purchase_return', 'dispense_return', 'wastage',
    'issue_out', 'issue_in', 'theatre_use'));

CREATE TABLE ot_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_rooms_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX ot_rooms_name ON ot_rooms (tenant_id, lower(name));
CREATE TRIGGER ot_rooms_touch BEFORE UPDATE ON ot_rooms
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
SELECT enable_tenant_rls('ot_rooms', 'SELECT, INSERT, UPDATE');

CREATE TABLE ot_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  room_id uuid NOT NULL,
  surgeon_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  service_id uuid,
  procedure text NOT NULL CHECK (char_length(procedure) BETWEEN 1 AND 200),
  notes text CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 500),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 300),
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_bookings_span CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '24 hours'),
  CONSTRAINT ot_bookings_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT ot_bookings_room FOREIGN KEY (tenant_id, room_id) REFERENCES ot_rooms (tenant_id, id),
  CONSTRAINT ot_bookings_surgeon FOREIGN KEY (tenant_id, surgeon_id) REFERENCES doctors (tenant_id, id),
  CONSTRAINT ot_bookings_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id),
  CONSTRAINT ot_bookings_service FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  -- One live booking at a time for a theatre, a surgeon and a patient. Half-open ranges, so one
  -- surgery may end as the next starts.
  CONSTRAINT ot_bookings_room_free EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled', 'in_progress')),
  CONSTRAINT ot_bookings_surgeon_free EXCLUDE USING gist (
    tenant_id WITH =, surgeon_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled', 'in_progress')),
  CONSTRAINT ot_bookings_patient_free EXCLUDE USING gist (
    tenant_id WITH =, patient_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled', 'in_progress'))
);
-- The calendar: bookings in a range, by start.
CREATE INDEX ot_bookings_calendar ON ot_bookings (tenant_id, starts_at, id);

CREATE FUNCTION ot_bookings_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['room_id', 'surgeon_id', 'starts_at', 'ends_at', 'status', 'started_at',
        'completed_at', 'cancelled_at', 'cancel_reason', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['room_id', 'surgeon_id', 'starts_at', 'ends_at', 'status', 'started_at',
        'completed_at', 'cancelled_at', 'cancel_reason', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the time, theatre, surgeon and progress of a booking change' USING ERRCODE = '42501';
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
CREATE TRIGGER ot_bookings_touch BEFORE UPDATE ON ot_bookings
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER ot_bookings_guard BEFORE UPDATE ON ot_bookings
  FOR EACH ROW EXECUTE FUNCTION ot_bookings_guard();
SELECT enable_tenant_rls('ot_bookings', 'SELECT, INSERT, UPDATE');

-- Stock used in a surgery: one row for each batch taken, grouped by the use that took them, and
-- the ledger entry that moved the stock. Never changed or removed.
CREATE TABLE ot_consumables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  use_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  ledger_entry_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_consumables_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
CREATE INDEX ot_consumables_booking ON ot_consumables (tenant_id, booking_id, recorded_at, id);
SELECT enable_tenant_rls('ot_consumables', 'SELECT, INSERT');
