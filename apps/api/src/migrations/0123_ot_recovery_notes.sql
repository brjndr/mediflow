-- Recovery-room notes of a surgery (#917). Insert-only: a correction is a new note.
CREATE TABLE ot_recovery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  pain_score integer CHECK (pain_score IS NULL OR pain_score BETWEEN 0 AND 10),
  readiness text NOT NULL CHECK (readiness IN ('in_recovery', 'ready_for_ward')),
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ot_recovery_notes_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
CREATE INDEX ot_recovery_notes_booking ON ot_recovery_notes (tenant_id, booking_id, added_at, id);
SELECT enable_tenant_rls('ot_recovery_notes', 'SELECT, INSERT');
