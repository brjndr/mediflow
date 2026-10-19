-- The OPD token queue (BE-18): today's tokens at the hospital, one numbered sequence per
-- department per calendar day at the hospital. What the database itself guarantees:
--
-- * Numbers are unique per department and day, and handed out by one counter row per department
--   and day, so two desks issuing at the same moment wait for each other instead of colliding.
-- * A patient has at most one token not yet served per department and day.
-- * A doctor serves one token at a time.
-- * A token moves only waiting -> called -> served, called -> skipped and skipped -> waiting, and a
--   served token is final. Its hospital, number, day, department and patient never change, and a
--   doctor is given to it once (from none), never taken away or swapped.
-- * Every reference carries the hospital, since foreign keys are checked without row-level
--   security.

CREATE TABLE queue_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  department_id uuid NOT NULL,
  day date NOT NULL,
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, department_id, day),
  CONSTRAINT queue_counters_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id)
);

SELECT enable_tenant_rls('queue_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE queue_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- The calendar day at the hospital the token is for.
  day date NOT NULL,
  department_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  -- Null while any doctor of the department may call it.
  doctor_id uuid,
  patient_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'called', 'served', 'skipped')),
  priority text
    CHECK (priority IN ('senior_citizen', 'pregnancy', 'disability', 'child', 'clinical_urgency')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid NOT NULL,
  -- The last time it was called.
  called_at timestamptz,
  call_count integer NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_tokens_number_taken UNIQUE (tenant_id, department_id, day, number),
  CONSTRAINT queue_tokens_called CHECK (status = 'waiting' OR called_at IS NOT NULL),
  CONSTRAINT queue_tokens_called_by_doctor CHECK (status IN ('waiting', 'skipped') OR doctor_id IS NOT NULL),
  CONSTRAINT queue_tokens_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT queue_tokens_department FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, id),
  CONSTRAINT queue_tokens_doctor FOREIGN KEY (tenant_id, doctor_id)
    REFERENCES doctors (tenant_id, id),
  -- So readings, and later encounters, can refer to a token together with the hospital.
  CONSTRAINT queue_tokens_tenant_id_id UNIQUE (tenant_id, id)
);

-- One token not yet served per patient, department and day.
CREATE UNIQUE INDEX queue_tokens_one_open ON queue_tokens (tenant_id, patient_id, department_id, day)
  WHERE status <> 'served';
-- A doctor serves one patient at a time.
CREATE UNIQUE INDEX queue_tokens_one_called ON queue_tokens (tenant_id, doctor_id, day)
  WHERE status = 'called';
-- The board: a department's tokens of one status on one day.
CREATE INDEX queue_tokens_tenant_day ON queue_tokens (tenant_id, day, department_id, status);
-- A doctor's queue.
CREATE INDEX queue_tokens_tenant_doctor_day ON queue_tokens (tenant_id, doctor_id, day, status);

-- No DELETE: a token is served, never removed.
SELECT enable_tenant_rls('queue_tokens', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION queue_tokens_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.day <> OLD.day
     OR NEW.department_id <> OLD.department_id OR NEW.number <> OLD.number
     OR NEW.patient_id <> OLD.patient_id OR NEW.issued_at <> OLD.issued_at
     OR NEW.issued_by <> OLD.issued_by THEN
    RAISE EXCEPTION 'A token''s hospital, number, department and patient cannot be changed'
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

CREATE TRIGGER queue_tokens_guard_update BEFORE UPDATE ON queue_tokens
  FOR EACH ROW EXECUTE FUNCTION queue_tokens_guard_update();
