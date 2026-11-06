-- Cancelling a queue token issued by mistake (Q-05, #377). What the database itself guarantees:
--
-- * A token is cancelled only from `waiting` or `skipped`, once: `cancelled` is final, as `served`
--   is. A called token cannot be cancelled.
-- * A cancelled token has a reason from a fixed list, who cancelled it and when; "other" says why
--   in a note, and no other reason carries one. No other token has any of these.
-- * A cancelled token no longer holds the patient's place: they can be issued another in that
--   department the same day. The number is never given out again (the counter only goes up).

ALTER TABLE queue_tokens
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancel_note text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid;

ALTER TABLE queue_tokens DROP CONSTRAINT queue_tokens_status_check;
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_status_check
  CHECK (status IN ('waiting', 'called', 'served', 'skipped', 'cancelled'));

-- A token cancelled while waiting was never called, and has no doctor.
ALTER TABLE queue_tokens DROP CONSTRAINT queue_tokens_called;
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_called
  CHECK (status IN ('waiting', 'cancelled') OR called_at IS NOT NULL);
ALTER TABLE queue_tokens DROP CONSTRAINT queue_tokens_called_by_doctor;
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_called_by_doctor
  CHECK (status IN ('waiting', 'skipped', 'cancelled') OR doctor_id IS NOT NULL);

ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_cancel_reason_known
  CHECK (cancel_reason IS NULL
         OR cancel_reason IN ('wrong_patient', 'wrong_department', 'left_without_being_seen', 'other'));
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_cancelled_says_why
  CHECK ((status = 'cancelled')
           = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL));
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_cancel_note
  CHECK (cancel_note IS NULL
         OR (cancel_reason = 'other' AND char_length(cancel_note) BETWEEN 1 AND 300));
ALTER TABLE queue_tokens ADD CONSTRAINT queue_tokens_other_has_note
  CHECK (cancel_reason IS DISTINCT FROM 'other' OR cancel_note IS NOT NULL);

-- A cancelled token is out of the way: the patient may be issued another.
DROP INDEX queue_tokens_one_open;
CREATE UNIQUE INDEX queue_tokens_one_open ON queue_tokens (tenant_id, patient_id, department_id, day)
  WHERE status NOT IN ('served', 'cancelled');
-- Postgres names the first unique index a row breaks, in the order the indexes were made: this one
-- is remade after the other so that an open token is still `already_queued`, as it was before.
DROP INDEX queue_tokens_one_per_appointment;
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
  IF OLD.status IN ('served', 'cancelled') THEN
    RAISE EXCEPTION 'A % token is final', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('waiting', 'called'), ('called', 'served'), ('called', 'skipped'), ('skipped', 'waiting'),
       ('waiting', 'cancelled'), ('skipped', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'A token does not move from % to %', OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
