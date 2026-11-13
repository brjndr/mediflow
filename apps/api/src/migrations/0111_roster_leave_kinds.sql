-- Leave kinds, yearly allowances and a policy for a hospital with no second approver (#667).
--
-- * A leave has a kind (`annual`, `sick`, `casual`, `unpaid`). Existing leaves are `annual`.
-- * `roster_leave_allowances`: days a person may take in a calendar year of each kind, the same for
--   everyone in the hospital. A kind with no row has no limit. What is used is read from the leaves.
-- * `roster_settings.self_approval`: `never` (a second person always decides, as before) or
--   `sole_manager` (the only active person holding roster:manage may approve their own leave when
--   nobody else could). Such a leave is marked `self_approved`, so it can always be told apart.

ALTER TABLE roster_leaves
  ADD COLUMN kind text NOT NULL DEFAULT 'annual' CHECK (kind IN ('annual', 'sick', 'casual', 'unpaid')),
  ADD COLUMN self_approved boolean NOT NULL DEFAULT false;

ALTER TABLE roster_leaves DROP CONSTRAINT roster_leaves_second_person;
ALTER TABLE roster_leaves ADD CONSTRAINT roster_leaves_second_person
  CHECK (decided_by IS NULL OR decided_by <> user_id OR (self_approved AND status = 'approved'));
ALTER TABLE roster_leaves ADD CONSTRAINT roster_leaves_self_approval
  CHECK (NOT self_approved OR decided_by = user_id);

CREATE OR REPLACE FUNCTION roster_leaves_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'self_approved', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'self_approved', 'version', 'updated_at'])
     OR NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status = 'cancelled')
     ) THEN
    RAISE EXCEPTION 'A leave only moves from requested to a decision, or to cancelled' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'approved' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.user_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM roster_shifts s
       WHERE s.tenant_id = NEW.tenant_id AND s.user_id = NEW.user_id AND s.status = 'scheduled'
         AND tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
    ) THEN
      RAISE EXCEPTION 'The person has scheduled shifts in that time'
        USING ERRCODE = '23P01', CONSTRAINT = 'roster_leave_has_shifts';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE roster_leave_allowances (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('annual', 'sick', 'casual', 'unpaid')),
  days integer NOT NULL CHECK (days BETWEEN 0 AND 366),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
SELECT enable_tenant_rls('roster_leave_allowances', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE roster_settings (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants (id),
  self_approval text NOT NULL DEFAULT 'never' CHECK (self_approval IN ('never', 'sole_manager')),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('roster_settings', 'SELECT, INSERT, UPDATE');
