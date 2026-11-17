-- Reminding an offboarding hospital's admins that its data will be deleted (#998, decided in #959):
-- 30 and 7 days before `delete_after`. `deletion_reminders` is the platform's table like
-- `tenant_exports`: no tenant_id, no foreign key, ids, codes and times only (never an address), so
-- the record that a reminder went out outlives the hospital. One row per reminder, hospital's date and
-- person, so a repeated run never sends one twice and a new `delete_after` (reactivated, then
-- offboarded again) is reminded afresh.
CREATE TABLE deletion_reminders (
  hospital_id uuid NOT NULL,
  user_id uuid NOT NULL,
  days_before smallint NOT NULL CHECK (days_before IN (30, 7)),
  delete_after timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, user_id, days_before, delete_after)
);

ALTER TABLE deletion_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON deletion_reminders FOR ALL TO mediflow_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON deletion_reminders TO mediflow_platform;

-- The active admins of an offboarding hospital, for the reminder only. The platform role has no
-- grant on users, so one narrow question is answered here: who to write to, and nothing else.
CREATE FUNCTION offboarding_admin_contacts(hospital uuid) RETURNS TABLE (user_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.email
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = hospital AND t.status = 'offboarding'
      AND m.role_id = 'admin' AND m.status = 'active' AND u.status = 'active'
      AND NOT u.is_platform_admin
  $$;
REVOKE ALL ON FUNCTION offboarding_admin_contacts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION offboarding_admin_contacts(uuid) TO mediflow_platform;
