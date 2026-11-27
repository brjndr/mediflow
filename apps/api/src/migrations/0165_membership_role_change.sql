-- Changing a staff member's role (#1191). The app role could update only a membership's status
-- and its session cut-off (migrations 0015, 0016); moving someone to another role needs the role
-- column too. Row-level security still limits the rows to the hospital of the request, and the
-- route checks the caller's own ceiling and that someone is left to manage the hospital.
GRANT UPDATE (role_id) ON memberships TO mediflow_app;
