-- Fluid intake and output, and care plans with tasks (NR-04, #160): more of what the ward
-- records about an admitted patient, with the guarantees of 0084.
--
-- * A fluid entry is append-only: the app role may insert and read, and a trigger refuses
--   UPDATE, DELETE and TRUNCATE to everyone. A correction is a new entry that names the one it
--   corrects, with a reason, once; it replaces the amount, and the totals count one of the two.
-- * A care plan moves only in its status (active, then completed or cancelled, never back) and
--   a task only in being done, once. Neither is removed. Plans and tasks are written only while
--   the stay is open, and so is ending a plan or doing a task.

CREATE TABLE ward_fluids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('intake', 'output')),
  kind text NOT NULL CHECK (kind IN (
    'oral', 'intravenous', 'tube', 'other_intake',
    'urine', 'drain', 'vomit', 'stool', 'other_output'
  )),
  amount_ml integer NOT NULL CHECK (amount_ml BETWEEN 1 AND 5000),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  corrects_id uuid,
  correction_reason text CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 200),
  CONSTRAINT ward_fluids_direction CHECK (
    (direction = 'intake') = (kind IN ('oral', 'intravenous', 'tube', 'other_intake'))
  ),
  CONSTRAINT ward_fluids_correction CHECK ((corrects_id IS NULL) = (correction_reason IS NULL)),
  CONSTRAINT ward_fluids_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT ward_fluids_tenant_id_admission UNIQUE (tenant_id, id, admission_id),
  CONSTRAINT ward_fluids_corrects FOREIGN KEY (tenant_id, corrects_id, admission_id)
    REFERENCES ward_fluids (tenant_id, id, admission_id)
);

CREATE INDEX ward_fluids_tenant_admission ON ward_fluids (tenant_id, admission_id, observed_at DESC, id DESC);
CREATE UNIQUE INDEX ward_fluids_corrected_once ON ward_fluids (tenant_id, corrects_id)
  WHERE corrects_id IS NOT NULL;

SELECT enable_tenant_rls('ward_fluids', 'SELECT, INSERT');

CREATE TRIGGER ward_fluids_open_stay BEFORE INSERT ON ward_fluids
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();
CREATE TRIGGER ward_fluids_never_change BEFORE UPDATE OR DELETE ON ward_fluids
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER ward_fluids_no_truncate BEFORE TRUNCATE ON ward_fluids
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();

-- --- care plans --------------------------------------------------------------------------------

CREATE TABLE care_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  problem text NOT NULL CHECK (length(problem) BETWEEN 1 AND 200),
  goal text CHECK (goal IS NULL OR length(goal) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  closed_at timestamptz,
  closed_by uuid,
  CONSTRAINT care_plans_closed CHECK ((status = 'active') = (closed_at IS NULL AND closed_by IS NULL)),
  CONSTRAINT care_plans_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id),
  CONSTRAINT care_plans_tenant_id_admission UNIQUE (tenant_id, id, admission_id)
);

CREATE INDEX care_plans_tenant_admission ON care_plans (tenant_id, admission_id, created_at DESC, id DESC);

SELECT enable_tenant_rls('care_plans', 'SELECT, INSERT, UPDATE');

CREATE TABLE care_plan_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  plan_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  done_at timestamptz,
  done_by uuid,
  done_note text CHECK (done_note IS NULL OR length(done_note) BETWEEN 1 AND 200),
  CONSTRAINT care_plan_tasks_done CHECK ((done_at IS NULL) = (done_by IS NULL)
    AND (done_note IS NULL OR done_at IS NOT NULL)),
  CONSTRAINT care_plan_tasks_plan FOREIGN KEY (tenant_id, plan_id, admission_id)
    REFERENCES care_plans (tenant_id, id, admission_id),
  CONSTRAINT care_plan_tasks_stay FOREIGN KEY (tenant_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (tenant_id, id, encounter_id, patient_id)
);

CREATE INDEX care_plan_tasks_tenant_plan ON care_plan_tasks (tenant_id, plan_id, created_at, id);

SELECT enable_tenant_rls('care_plan_tasks', 'SELECT, INSERT, UPDATE');

CREATE TRIGGER care_plans_open_stay BEFORE INSERT ON care_plans
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();
CREATE TRIGGER care_plan_tasks_open_stay BEFORE INSERT ON care_plan_tasks
  FOR EACH ROW EXECUTE FUNCTION nursing_open_stay();

-- A plan moves only from active to completed or cancelled; a task is done once. Both while the stay is open.
CREATE FUNCTION care_plans_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  moved text[] := ARRAY['status', 'closed_at', 'closed_by'];
BEGIN
  IF (to_jsonb(NEW) - moved) IS DISTINCT FROM (to_jsonb(OLD) - moved) THEN
    RAISE EXCEPTION 'Only the status of a care plan changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'A closed care plan does not change' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM admissions a
    JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
    WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.admission_id
      AND a.status = 'admitted' AND e.type = 'ipd' AND e.status = 'open'
  ) THEN
    RAISE EXCEPTION 'The stay is not open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION care_plan_tasks_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  moved text[] := ARRAY['done_at', 'done_by', 'done_note'];
BEGIN
  IF (to_jsonb(NEW) - moved) IS DISTINCT FROM (to_jsonb(OLD) - moved) THEN
    RAISE EXCEPTION 'Only the doing of a care plan task changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.done_at IS NOT NULL THEN
    RAISE EXCEPTION 'A task done stays done' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM admissions a
    JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
    WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.admission_id
      AND a.status = 'admitted' AND e.type = 'ipd' AND e.status = 'open'
  ) THEN
    RAISE EXCEPTION 'The stay is not open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER care_plans_guard_update BEFORE UPDATE ON care_plans
  FOR EACH ROW EXECUTE FUNCTION care_plans_guard_update();
CREATE TRIGGER care_plan_tasks_guard_update BEFORE UPDATE ON care_plan_tasks
  FOR EACH ROW EXECUTE FUNCTION care_plan_tasks_guard_update();
CREATE TRIGGER care_plans_never_deleted BEFORE DELETE ON care_plans
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER care_plan_tasks_never_deleted BEFORE DELETE ON care_plan_tasks
  FOR EACH ROW EXECUTE FUNCTION nursing_never_change();
CREATE TRIGGER care_plans_no_truncate BEFORE TRUNCATE ON care_plans
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
CREATE TRIGGER care_plan_tasks_no_truncate BEFORE TRUNCATE ON care_plan_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION nursing_no_truncate();
