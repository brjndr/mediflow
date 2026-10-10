-- Roles and permissions.
--
-- Access is decided by permissions (`resource:action`). A role is a named bundle of them that
-- belongs to one hospital: the same role id can carry different permissions at each hospital,
-- and a hospital can have roles of its own.

-- A hospital's roles. Built-in ones are created with the hospital (see the trigger below) and
-- can have their permissions changed but cannot be deleted; custom ones are the hospital's own.
CREATE TABLE roles (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-z][a-z0-9_]*$' AND length(id) <= 63),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  built_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- Read-only for the app role until the role management API (BE-16) grants more.
SELECT enable_tenant_rls('roles', 'SELECT');

-- What a role may do. The scope narrows a permission to the user's own records or department;
-- the backend applies it when it reads data.
CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL,
  role_id text NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z][A-Za-z0-9_.]*:[a-z][A-Za-z0-9_]*$' AND length(permission) <= 127),
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'own', 'department')),
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

SELECT enable_tenant_rls('role_permissions', 'SELECT');

-- Which default grants a built-in role has already been given. A default is applied once per
-- hospital, role and permission: a grant the hospital's admin later removes is not put back by
-- the next deploy, while a permission added by a new feature still arrives.
CREATE TABLE role_default_grants (
  tenant_id uuid NOT NULL,
  role_id text NOT NULL,
  permission text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

SELECT enable_tenant_rls('role_default_grants', 'SELECT');

-- Authentication builds the access policy into the session response, so it reads the roles and
-- grants of the hospitals the identified user belongs to. Only those.
CREATE POLICY auth_member ON roles FOR SELECT TO mediflow_auth USING (
  EXISTS (
    SELECT FROM memberships m
    WHERE m.tenant_id = roles.tenant_id AND m.user_id = app_user_id() AND m.status = 'active'
  )
);
GRANT SELECT ON roles TO mediflow_auth;

CREATE POLICY auth_member ON role_permissions FOR SELECT TO mediflow_auth USING (
  EXISTS (
    SELECT FROM memberships m
    WHERE m.tenant_id = role_permissions.tenant_id AND m.user_id = app_user_id() AND m.status = 'active'
  )
);
GRANT SELECT ON role_permissions TO mediflow_auth;

-- The built-in roles of a hospital. `platform_admin` is not here: it belongs to no hospital.
-- Their default permissions come from the features' own declarations and are applied by the API
-- (`pnpm --filter api db:migrate` runs that step after the migrations).
CREATE FUNCTION seed_built_in_roles(target_tenant uuid) RETURNS void
  LANGUAGE sql
  AS $$
    INSERT INTO roles (tenant_id, id, name, built_in)
    SELECT target_tenant, role.id, role.name, true
    FROM (VALUES
      ('admin', 'Administrator'),
      ('doctor', 'Doctor'),
      ('nurse', 'Nurse'),
      ('receptionist', 'Receptionist'),
      ('pharmacist', 'Pharmacist'),
      ('lab_technician', 'Lab technician'),
      ('radiologist', 'Radiologist'),
      ('store_keeper', 'Store keeper')
    ) AS role (id, name)
    ON CONFLICT (tenant_id, id) DO NOTHING
  $$;

-- Every hospital has its built-in roles from the moment it exists.
CREATE FUNCTION tenants_seed_roles() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM seed_built_in_roles(NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER tenants_seed_roles AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_seed_roles();

-- Hospitals that already exist.
SELECT seed_built_in_roles(id) FROM tenants;

-- Role ids already in use that are not built in (a hospital's own roles) become roles too, so
-- the foreign keys below hold. They start with no permissions.
INSERT INTO roles (tenant_id, id, name)
SELECT DISTINCT used.tenant_id, used.role_id, initcap(replace(used.role_id, '_', ' '))
FROM (
  SELECT tenant_id, role_id FROM memberships
  UNION
  SELECT tenant_id, role_id FROM invites
) AS used
ON CONFLICT (tenant_id, id) DO NOTHING;

-- A membership or an invite can only name a role its hospital has.
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id);
ALTER TABLE invites
  ADD CONSTRAINT invites_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id);

-- The access policy a client holds carries a version, so it can tell when to reload. This is the
-- hospital's part of it: a counter that moves whenever anything that feeds a policy changes.
ALTER TABLE tenants ADD COLUMN policy_revision bigint NOT NULL DEFAULT 1;

-- Bumped by triggers, not by application code, so no code path that changes a role, a grant or
-- a module flag can forget to. SECURITY DEFINER because the roles that make such changes cannot
-- (and should not) update the tenants table themselves.
CREATE FUNCTION bump_policy_revision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
DECLARE
  changed_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_tenant := OLD.tenant_id;
  ELSE
    changed_tenant := NEW.tenant_id;
  END IF;
  -- While a hospital is being deleted its row is already gone, and this changes nothing.
  UPDATE tenants SET policy_revision = policy_revision + 1 WHERE id = changed_tenant;
  RETURN NULL;
END
$$;

CREATE TRIGGER roles_bump_policy AFTER INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION bump_policy_revision();
CREATE TRIGGER role_permissions_bump_policy AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION bump_policy_revision();
CREATE TRIGGER tenant_features_bump_policy AFTER INSERT OR UPDATE OR DELETE ON tenant_features
  FOR EACH ROW EXECUTE FUNCTION bump_policy_revision();
