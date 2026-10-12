-- "Sign out everywhere" has to cover every session a person could use at the hospital, and a
-- session is bound to one hospital at a time: one that sits at the hospital picker, or is at
-- another hospital just now, is not bound here and cannot be found by the hospital that wants it
-- ended. So the hospital records a moment instead, on its own membership row: a session opened
-- before it can no longer be used at this hospital. The person signs in again; their sessions at
-- other hospitals carry on.
ALTER TABLE memberships ADD COLUMN sessions_valid_after timestamptz;
COMMENT ON COLUMN memberships.sessions_valid_after IS
  'A session opened before this moment cannot be used at this hospital. Null: no such limit.';
GRANT UPDATE (sessions_valid_after) ON memberships TO mediflow_app;

-- A session that was ended stays ended, whoever asks. The app role may mark a session revoked
-- (migration 0015); without this it could also clear the mark and reopen a session that was
-- ended for a copied token or by the person signing out.
CREATE FUNCTION sessions_stay_revoked() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'A session that was ended cannot be reopened' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_stay_revoked BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_stay_revoked();
