-- The account page (#257): a person sees and ends their own sessions, and changes their password.

-- What the person recognises a session by. Cleaned and capped when written (cleanUserAgent).
ALTER TABLE sessions ADD COLUMN user_agent text CHECK (length(user_agent) <= 200);

-- A session the person ended from another one.
ALTER TABLE sessions DROP CONSTRAINT sessions_revoke_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoke_reason_check CHECK (
  revoke_reason IN ('logout', 'idle', 'expired', 'token_reuse', 'replaced', 'password_changed', 'admin', 'revoked_by_user')
);

-- What a person did to their own account: changed the password, ended a session. Ids and codes
-- only. Append-only like the audit log, and a person's account events belong to the person, not to
-- a hospital, so it is not a tenant table. There is no foreign key to users on purpose: the trail
-- must not be deleted with the user, and the append-only trigger would refuse a cascade anyway.
CREATE TABLE account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) <= 64),
  entity text NOT NULL CHECK (length(entity) <= 64),
  entity_id text CHECK (length(entity_id) <= 64),
  request_id text CHECK (length(request_id) <= 128),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_events_user ON account_events (user_id, at);

CREATE FUNCTION account_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'account_events is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER account_events_no_change BEFORE UPDATE OR DELETE ON account_events
  FOR EACH ROW EXECUTE FUNCTION account_events_immutable();
CREATE TRIGGER account_events_no_truncate BEFORE TRUNCATE ON account_events
  FOR EACH STATEMENT EXECUTE FUNCTION account_events_immutable();

ALTER TABLE account_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_events FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_own ON account_events FOR ALL TO mediflow_auth
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT ON account_events TO mediflow_auth;
