-- Operation note and charges of a surgery (#178). Additive.
--
-- * A surgery may name the visit (encounter) its charges go to; set while it is scheduled or in
--   progress, by the guard below (a finished booking stays closed).
-- * The operation note is one row for each surgery: a draft that is replaced until it is signed,
--   then closed by a trigger. A signed note is corrected by addenda, which are insert-only.

ALTER TABLE ot_bookings ADD COLUMN encounter_id uuid;
ALTER TABLE ot_bookings ADD CONSTRAINT ot_bookings_encounter
  FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounters (tenant_id, id);

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

CREATE TABLE ot_notes (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  procedure_done text NOT NULL CHECK (char_length(procedure_done) BETWEEN 1 AND 300),
  findings text CHECK (findings IS NULL OR char_length(findings) BETWEEN 1 AND 2000),
  technique text CHECK (technique IS NULL OR char_length(technique) BETWEEN 1 AND 2000),
  complications text CHECK (complications IS NULL OR char_length(complications) BETWEEN 1 AND 1000),
  blood_loss_ml integer CHECK (blood_loss_ml IS NULL OR blood_loss_ml BETWEEN 0 AND 20000),
  specimens text CHECK (specimens IS NULL OR char_length(specimens) BETWEEN 1 AND 500),
  post_op_plan text CHECK (post_op_plan IS NULL OR char_length(post_op_plan) BETWEEN 1 AND 1000),
  saved_by uuid NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  signed_by uuid,
  CONSTRAINT ot_notes_signed CHECK ((signed_at IS NULL) = (signed_by IS NULL)),
  PRIMARY KEY (tenant_id, booking_id),
  CONSTRAINT ot_notes_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
CREATE FUNCTION ot_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A signed operation note is never changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ot_notes_guard BEFORE UPDATE ON ot_notes
  FOR EACH ROW EXECUTE FUNCTION ot_notes_guard();
SELECT enable_tenant_rls('ot_notes', 'SELECT, INSERT, UPDATE');

CREATE TABLE ot_note_addenda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_note_addenda_note FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_notes (tenant_id, booking_id)
);
CREATE INDEX ot_note_addenda_booking ON ot_note_addenda (tenant_id, booking_id, added_at, id);
SELECT enable_tenant_rls('ot_note_addenda', 'SELECT, INSERT');
