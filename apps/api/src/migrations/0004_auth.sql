-- Identity and sessions.
--
-- Signing in has to find a person and the hospitals they work at before any hospital is active,
-- which the tenant-scoped app role cannot do by design. So authentication runs as its own role,
-- mediflow_auth, which can touch the identity tables below and nothing else: it has no grant on
-- any table that holds hospital data. Like the app role, it is not a superuser and cannot bypass
-- row-level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_auth') THEN
    CREATE ROLE mediflow_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT mediflow_auth TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_auth;

-- The user of the current auth transaction, set once the caller is known (after a password is
-- verified, or from a valid session). NULL before that, and a comparison with NULL is never true.
CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_user_id() TO mediflow_auth, mediflow_app;

-- A person who can sign in. Global, not owned by a hospital: one person can work at several.
-- Staff only. Patients are records, never users.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Always stored lower-cased, so "A@x" and "a@x" are one account.
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%' AND length(email) <= 254),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Product operators. Not scoped to a hospital and with no access to patient data.
  is_platform_admin boolean NOT NULL DEFAULT false,
  -- Lockout after repeated failed sign-ins.
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (email);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- Sign-in looks a user up by email before anyone is identified, so the auth role reads them all.
CREATE POLICY auth_all ON users FOR ALL TO mediflow_auth USING (true) WITH CHECK (true);
-- It may read users and maintain the lockout counters. It may not create, rename or delete them.
GRANT SELECT ON users TO mediflow_auth;
GRANT UPDATE (failed_login_count, locked_until, updated_at) ON users TO mediflow_auth;

-- How a user proves who they are. One row per provider: a password today, a hospital's single
-- sign-on (OIDC or SAML) later, with the provider's own subject for that user.
CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('password', 'oidc', 'saml')),
  -- For `password`, the user's id. For single sign-on, the identity provider's subject.
  subject text NOT NULL,
  -- The Argon2id hash for `password`. NULL for single sign-on. Never the password itself.
  secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject),
  CHECK ((provider = 'password') = (secret_hash IS NOT NULL))
);
CREATE UNIQUE INDEX user_identities_one_password ON user_identities (user_id) WHERE provider = 'password';
CREATE INDEX user_identities_user ON user_identities (user_id);

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_all ON user_identities FOR ALL TO mediflow_auth USING (true) WITH CHECK (true);
GRANT SELECT ON user_identities TO mediflow_auth;

-- A user's place at a hospital: which hospital, and in which role there.
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- A role of that hospital. Roles and their permissions arrive with BE-05.
  role_id text NOT NULL CHECK (role_id ~ '^[a-z][a-z0-9_]*$' AND length(role_id) <= 63),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One membership per person per hospital. Also the tenant-first index.
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- A hospital sees its own memberships (read-only until staff management exists).
SELECT enable_tenant_rls('memberships', 'SELECT');
-- Authentication sees the memberships of the user it has identified, and no one else's.
CREATE POLICY auth_own ON memberships FOR SELECT TO mediflow_auth USING (user_id = app_user_id());
GRANT SELECT ON memberships TO mediflow_auth;

-- To build the session response, authentication reads the hospitals the identified user belongs
-- to and their module flags. Only those: a hospital the user is not a member of is invisible.
CREATE POLICY auth_member ON tenants FOR SELECT TO mediflow_auth USING (
  EXISTS (
    SELECT FROM memberships m
    WHERE m.tenant_id = tenants.id AND m.user_id = app_user_id() AND m.status = 'active'
  )
);
GRANT SELECT ON tenants TO mediflow_auth;

CREATE POLICY auth_member ON tenant_features FOR SELECT TO mediflow_auth USING (
  EXISTS (
    SELECT FROM memberships m
    WHERE m.tenant_id = tenant_features.tenant_id AND m.user_id = app_user_id() AND m.status = 'active'
  )
);
GRANT SELECT ON tenant_features TO mediflow_auth;

-- A signed-in browser. The cookie holds a random token; only its SHA-256 hash is stored here, so
-- a copy of this table cannot be used to impersonate anyone.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Exactly one hospital is active at a time, or none until the user picks one.
  active_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  -- The token this one replaced. Accepted for a short grace period after a rotation, so requests
  -- already in flight still work. Seen after that, it means a token was copied: the session is
  -- revoked.
  previous_token_hash bytea UNIQUE CHECK (octet_length(previous_token_hash) = 32),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Absolute lifetime: the session ends here however active it is.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (
    revoke_reason IN ('logout', 'idle', 'expired', 'token_reuse', 'replaced', 'password_changed', 'admin')
  ),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
-- A session is found by its token before the user is known, so the auth role reads them all.
CREATE POLICY auth_all ON sessions FOR ALL TO mediflow_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON sessions TO mediflow_auth;
