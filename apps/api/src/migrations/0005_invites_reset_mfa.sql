-- Invites, password resets and the second sign-in factor.
--
-- The issue calls for one `auth_tokens` table. It is two here: an invite belongs to a hospital
-- (its admin lists and revokes its invites), so it is a tenant table under the usual template,
-- while a password reset belongs to a person and to no hospital.

-- An invitation for one email address to join one hospital in one role. The link in the email
-- carries a random token; only its SHA-256 hash is stored.
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%' AND length(email) <= 254),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  role_id text NOT NULL CHECK (role_id ~ '^[a-z][a-z0-9_]*$' AND length(role_id) <= 63),
  -- Who sent it. Kept when that person's account is removed.
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  -- Single use: set when the invite is accepted.
  accepted_at timestamptz,
  -- Set when it is withdrawn, or replaced by a newer invite to the same address.
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invites_tenant_created ON invites (tenant_id, created_at);
-- At most one open invite per address per hospital.
CREATE UNIQUE INDEX invites_one_open ON invites (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

SELECT enable_tenant_rls('invites');

-- Accepting happens before anyone is signed in, so authentication finds an invite by its token.
CREATE POLICY auth_read ON invites FOR SELECT TO mediflow_auth USING (true);
CREATE POLICY auth_accept ON invites FOR UPDATE TO mediflow_auth USING (true) WITH CHECK (true);
GRANT SELECT ON invites TO mediflow_auth;
-- It may mark an invite accepted. It may not create one, or change who or what it is for.
GRANT UPDATE (accepted_at) ON invites TO mediflow_auth;

-- The hospital's name for the "you were invited to ..." screen, shown to whoever holds the link.
-- Authentication cannot read a hospital the user is not yet a member of, so this function answers
-- that one question for an open invite and nothing else.
CREATE FUNCTION invite_hospital_name(invite_token_hash bytea) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT t.name
    FROM invites i JOIN tenants t ON t.id = i.tenant_id
    WHERE i.token_hash = invite_token_hash
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  $$;
REVOKE ALL ON FUNCTION invite_hospital_name(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_hospital_name(bytea) TO mediflow_auth;

-- Accepting an invite may create the person's account and their password. A new account is a
-- name and an email only: the role cannot make a platform admin, or set any other column.
GRANT INSERT (email, name) ON users TO mediflow_auth;
GRANT INSERT ON user_identities TO mediflow_auth;
-- Setting a new password (reset). Not the provider, the subject or whose identity it is.
GRANT UPDATE (secret_hash, updated_at) ON user_identities TO mediflow_auth;

-- Accepting an invite creates the membership. The database itself checks that there is an open
-- invite for this person's email, to this hospital, in this role: a bug in the application
-- cannot put someone into a hospital that did not invite them, or into a higher role.
CREATE POLICY auth_accept_invite ON memberships FOR INSERT TO mediflow_auth WITH CHECK (
  user_id = app_user_id()
  AND status = 'active'
  AND EXISTS (
    SELECT FROM invites i
    JOIN users u ON u.email = i.email
    WHERE u.id = app_user_id()
      AND i.tenant_id = memberships.tenant_id
      AND i.role_id = memberships.role_id
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  )
);
GRANT INSERT ON memberships TO mediflow_auth;

-- A "forgot my password" link. Same shape as an invite's token: random, hashed, single use.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  -- Set when the link is used, or when a newer link replaces it.
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at);

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
-- Found by token before the user is known.
CREATE POLICY auth_all ON password_resets FOR ALL TO mediflow_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON password_resets TO mediflow_auth;
GRANT UPDATE (used_at) ON password_resets TO mediflow_auth;

-- A user's authenticator app (TOTP). The shared secret has to be readable to check a code, so it
-- cannot be hashed; it is encrypted by the API (AES-256-GCM) with a key the database never sees.
CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_encrypted bytea NOT NULL,
  -- NULL while the user is still setting it up. Sign-in asks for a code only once this is set.
  confirmed_at timestamptz,
  -- The 30-second step of the last accepted code. A code is never accepted twice.
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa FORCE ROW LEVEL SECURITY;
-- Only for the user the transaction has identified: after their password, or from their session.
CREATE POLICY auth_own ON user_mfa FOR ALL TO mediflow_auth
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO mediflow_auth;

-- One-time codes for when the authenticator is lost. Shown once, stored hashed.
CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_own ON mfa_recovery_codes FOR ALL TO mediflow_auth
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, DELETE ON mfa_recovery_codes TO mediflow_auth;
GRANT UPDATE (used_at) ON mfa_recovery_codes TO mediflow_auth;
