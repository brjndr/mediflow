-- Checking in a booked patient (Q-04, #376): a token issued from today's appointment. What the
-- database itself guarantees:
--
-- * An appointment gives at most one token, ever: checking in again finds the first one.
-- * The reference carries the hospital, as every other reference of the queue does.
-- * A token's place in the line (`line_at`) is set when it is issued and never changes. For a
--   walk-in it is the time issued; for a booked patient the booked time when they came before it,
--   the time issued when they came after it. Tokens issued before this migration have none and
--   are ordered by the time issued, as they were.

ALTER TABLE queue_tokens
  ADD COLUMN appointment_id uuid,
  ADD COLUMN line_at timestamptz,
  ADD CONSTRAINT queue_tokens_appointment FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES appointments (tenant_id, id);

CREATE UNIQUE INDEX queue_tokens_one_per_appointment ON queue_tokens (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION queue_tokens_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.day <> OLD.day
     OR NEW.department_id <> OLD.department_id OR NEW.number <> OLD.number
     OR NEW.patient_id <> OLD.patient_id OR NEW.issued_at <> OLD.issued_at
     OR NEW.issued_by <> OLD.issued_by
     OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.line_at IS DISTINCT FROM OLD.line_at THEN
    RAISE EXCEPTION 'A token''s hospital, number, department, patient and place cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.doctor_id IS NOT NULL AND NEW.doctor_id IS DISTINCT FROM OLD.doctor_id THEN
    RAISE EXCEPTION 'A token''s doctor is given once' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'served' THEN
    RAISE EXCEPTION 'A served token is final' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('waiting', 'called'), ('called', 'served'), ('called', 'skipped'), ('skipped', 'waiting')
     ) THEN
    RAISE EXCEPTION 'A token does not move from % to %', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
