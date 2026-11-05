-- Platform administration (BE-15, #132).
--
-- Platform admins onboard and operate hospitals. They have no access to patient data, so they get
-- a database role of their own, mediflow_platform, like authentication has mediflow_auth: it can
-- reach the hospital's configuration and nothing that holds patient, clinical or billing data, and
-- like the other roles it is not a superuser and cannot bypass row-level security. A platform
-- request never sets a tenant and never runs as the app role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_platform') THEN
    CREATE ROLE mediflow_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_platform TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_platform;

-- A hospital that is being offboarded is closed to its staff like a suspended one. Widening the
-- list of values changes no existing row.
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'suspended', 'offboarding'));

ALTER TABLE tenants
  -- Moves with every platform edit, so two platform admins editing one hospital cannot overwrite
  -- each other unseen.
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  -- Where the hospital's data lives (a region code chosen at onboarding). Null: the default one.
  ADD COLUMN region text CHECK (region ~ '^[a-z][a-z0-9-]*$' AND length(region) <= 31),
  -- Limits the plan sets for the hospital. Null: no limit.
  ADD COLUMN max_users integer CHECK (max_users > 0),
  ADD COLUMN storage_mb integer CHECK (storage_mb > 0),
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN offboarding_requested_at timestamptz,
  -- When the hospital's data may be deleted, after its export. Nothing deletes it yet.
  ADD COLUMN delete_after timestamptz,
  ADD CONSTRAINT tenants_offboarding_dates CHECK (
    (status = 'offboarding') = (offboarding_requested_at IS NOT NULL)
    AND (delete_after IS NULL OR offboarding_requested_at IS NOT NULL)
  );

-- Creating a hospital seeds what every hospital starts with: its built-in roles and its standard
-- price list. The triggers now run as the table owner, so the platform role needs no grant on
-- roles or price lists to onboard one.
CREATE OR REPLACE FUNCTION tenants_seed_roles() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM seed_built_in_roles(NEW.id);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION tenants_seed_price_list() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  INSERT INTO price_lists (tenant_id, name, standard) VALUES (NEW.id, 'Standard', true);
  RETURN NEW;
END;
$$;

-- Whether an address is a platform admin's. The platform role has no grant on users, and one
-- question is all the first-admin invite needs: it must never put a platform admin into a
-- hospital, which would give them the hospital's data through an ordinary membership.
CREATE FUNCTION is_platform_admin_email(candidate text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT FROM users WHERE email = lower(btrim(candidate)) AND is_platform_admin) $$;
REVOKE ALL ON FUNCTION is_platform_admin_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_platform_admin_email(text) TO mediflow_platform;

-- The hospital's configuration. Not its data.
CREATE POLICY platform_all ON tenants FOR ALL TO mediflow_platform USING (true) WITH CHECK (true);
GRANT SELECT ON tenants TO mediflow_platform;
GRANT INSERT (
  slug, name, locale, timezone, currency, theme_primary, theme_logo_url, address, phone,
  registration_number, auth_mode, region, max_users, storage_mb
) ON tenants TO mediflow_platform;
GRANT UPDATE (
  name, locale, timezone, currency, theme_primary, theme_logo_url, address, phone,
  registration_number, auth_mode, region, max_users, storage_mb, status, suspended_at,
  offboarding_requested_at, delete_after, version, updated_at
) ON tenants TO mediflow_platform;

CREATE POLICY platform_all ON tenant_features FOR ALL TO mediflow_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON tenant_features TO mediflow_platform;

-- Roles and their grants are read, and the default grants of a new hospital are written. A
-- hospital's admin edits them afterwards (BE-16).
CREATE POLICY platform_read ON roles FOR SELECT TO mediflow_platform USING (true);
GRANT SELECT ON roles TO mediflow_platform;
CREATE POLICY platform_all ON role_permissions FOR ALL TO mediflow_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON role_permissions TO mediflow_platform;
CREATE POLICY platform_all ON role_default_grants FOR ALL TO mediflow_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON role_default_grants TO mediflow_platform;

-- The first admin of a hospital is invited here. The platform role can add an invite and withdraw
-- one, and can read all of it but the token's hash: the email job gives an invite its token.
CREATE POLICY platform_all ON invites FOR ALL TO mediflow_platform USING (true) WITH CHECK (true);
GRANT INSERT ON invites TO mediflow_platform;
GRANT SELECT (
  id, tenant_id, email, name, role_id, invited_by, expires_at, accepted_at, revoked_at, created_at
) ON invites TO mediflow_platform;
GRANT UPDATE (revoked_at) ON invites TO mediflow_platform;

-- How many people work at a hospital, and in which role. Not who they treat.
CREATE POLICY platform_read ON memberships FOR SELECT TO mediflow_platform USING (true);
GRANT SELECT (tenant_id, user_id, role_id, status) ON memberships TO mediflow_platform;

-- What platform admins did. A hospital's own audit_log is for its staff's access to its data; this
-- is the operators' trail, append-only like it. `hospital_id` has no foreign key and is not named
-- tenant_id, because the row is the platform's, not a hospital's: the trail outlives the hospital.
CREATE TABLE platform_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 63),
  entity text NOT NULL CHECK (length(entity) BETWEEN 1 AND 63),
  entity_id text,
  hospital_id uuid,
  -- Ids and codes only: which module, which status. Never a name, an address or free text.
  detail jsonb NOT NULL DEFAULT '{}',
  request_id text
);
CREATE INDEX platform_audit_log_at ON platform_audit_log (at DESC, id);
CREATE INDEX platform_audit_log_hospital ON platform_audit_log (hospital_id, at DESC);

CREATE FUNCTION platform_audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER platform_audit_log_no_change BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_immutable();
CREATE TRIGGER platform_audit_log_no_truncate BEFORE TRUNCATE ON platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_log_immutable();

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON platform_audit_log FOR ALL TO mediflow_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform_audit_log TO mediflow_platform;

-- Idempotency keys of platform requests. A platform admin belongs to no hospital, so the keys of
-- core/idempotency (scoped to a hospital) do not fit. Only the id of what was made is kept.
CREATE TABLE platform_requests (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  -- SHA-256 of the operation and its body: the same key with another request is refused.
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX platform_requests_created ON platform_requests (created_at);

ALTER TABLE platform_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON platform_requests FOR ALL TO mediflow_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON platform_requests TO mediflow_platform;
