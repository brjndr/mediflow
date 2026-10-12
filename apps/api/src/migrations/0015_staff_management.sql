-- Staff management (BE-10): a hospital sees who works there, deactivates and reactivates a
-- membership, and ends the sessions someone has there.
--
-- Until now the app role (a hospital's own requests) could read its memberships and nothing of
-- the people behind them. Each grant below is the least that staff management needs, by column
-- and by row, and row-level security keeps every one of them to the hospital of the request.

-- 1. The name and the email address of the hospital's own members. Not the account's status, its
--    lockout counters or anything of its sign-in, and nobody who is not a member here.
CREATE POLICY tenant_members ON users FOR SELECT TO mediflow_app USING (
  EXISTS (
    SELECT FROM memberships m
    WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id()
  )
);
GRANT SELECT (id, name, email) ON users TO mediflow_app;

-- 2. A membership's status. The hospital, the person and the role stay as they are: joining is
--    by invitation only, and changing a role belongs to role management. The existing
--    tenant_isolation policy (FOR ALL) already limits the rows to the hospital's own.
GRANT UPDATE (status, updated_at) ON memberships TO mediflow_app;

-- A deactivated membership is `suspended`: kept, never deleted, so accepting an invitation
-- cannot bring it back (the membership already exists) and its history stays.
COMMENT ON COLUMN memberships.status IS
  'active, or suspended once the hospital has deactivated the membership. Kept, never deleted.';

-- 3. Ending sessions that are bound to this hospital. The app role sees which sessions those
--    are and marks them revoked. It never sees a token hash and cannot create or move a session.
CREATE POLICY tenant_bound ON sessions FOR SELECT TO mediflow_app
  USING (active_tenant_id = app_tenant_id());
CREATE POLICY tenant_revoke ON sessions FOR UPDATE TO mediflow_app
  USING (active_tenant_id = app_tenant_id())
  WITH CHECK (active_tenant_id = app_tenant_id());
GRANT SELECT (id, user_id, active_tenant_id, revoked_at) ON sessions TO mediflow_app;
GRANT UPDATE (revoked_at, revoke_reason) ON sessions TO mediflow_app;

-- The staff list is searched and ordered by name within one hospital.
CREATE INDEX memberships_tenant_status ON memberships (tenant_id, status, user_id);
