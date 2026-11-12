-- Leave requests for the duty roster (#591).
--
-- * A member of staff asks for time off (`requested`); a second person with roster:manage approves
--   or rejects it, once. The asker may withdraw a request or an approved leave (`cancelled`).
-- * An approved leave keeps its person off the roster: a shift cannot be scheduled into it, and a
--   leave cannot be approved while a scheduled shift overlaps it. Both are checked here, under one
--   lock for the person, so the two cannot pass each other.
-- * Only the status, who decided and when change; the period and person never do. No reason is
--   kept (a reason for leave can be health information).

CREATE TABLE roster_leaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  user_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_leaves_in_order CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '90 days'),
  CONSTRAINT roster_leaves_second_person CHECK (decided_by IS NULL OR decided_by <> user_id),
  CONSTRAINT roster_leaves_decision CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)
    OR status = 'cancelled'),
  CONSTRAINT roster_leaves_member FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT roster_leaves_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT roster_leaves_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('requested', 'approved'))
);
CREATE INDEX roster_leaves_tenant_start ON roster_leaves (tenant_id, starts_at, id);
CREATE INDEX roster_leaves_tenant_user ON roster_leaves (tenant_id, user_id, starts_at);

CREATE FUNCTION roster_leaves_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'version', 'updated_at'])
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
CREATE TRIGGER roster_leaves_touch BEFORE UPDATE ON roster_leaves
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER roster_leaves_guard BEFORE UPDATE ON roster_leaves
  FOR EACH ROW EXECUTE FUNCTION roster_leaves_guard_update();

SELECT enable_tenant_rls('roster_leaves', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION roster_shifts_guard_leave() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status = 'scheduled' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.user_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM roster_leaves l
       WHERE l.tenant_id = NEW.tenant_id AND l.user_id = NEW.user_id AND l.status = 'approved'
         AND tstzrange(l.starts_at, l.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
    ) THEN
      RAISE EXCEPTION 'The person is on approved leave then'
        USING ERRCODE = '23P01', CONSTRAINT = 'roster_shift_on_leave';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER roster_shifts_leave BEFORE INSERT ON roster_shifts
  FOR EACH ROW EXECUTE FUNCTION roster_shifts_guard_leave();
