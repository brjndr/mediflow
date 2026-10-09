-- A hospital. Every other tenant-owned table references this one through tenant_id.
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable, URL-safe name. Not used for tenant resolution (that comes from the session).
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- No defaults: each hospital states its own locale, timezone and currency at onboarding.
  locale text NOT NULL,
  timezone text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  theme_primary text NOT NULL CHECK (theme_primary ~ '^#[0-9a-fA-F]{6}$'),
  theme_logo_url text,
  auth_mode text NOT NULL DEFAULT 'password' CHECK (auth_mode IN ('password', 'sso')),
  -- A suspended hospital keeps its data but its staff cannot use the app.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- tenants has no tenant_id column (its id is the tenant), so it gets its own policy instead of
-- the template. The app role may read its own hospital's row and nothing else, and may not
-- change it: hospitals are created, configured and suspended through the platform path.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants FOR SELECT TO mediflow_app USING (id = app_tenant_id());
GRANT SELECT ON tenants TO mediflow_app;

-- Which modules are switched on for a hospital. Absent means off.
CREATE TABLE tenant_features (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]*$' AND length(feature) <= 63),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Starts with tenant_id, as every index on a tenant table does.
  PRIMARY KEY (tenant_id, feature)
);

-- Read-only for the app role: a hospital cannot switch its own modules on. That is a platform
-- admin action.
SELECT enable_tenant_rls('tenant_features', 'SELECT');
