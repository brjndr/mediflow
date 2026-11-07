-- Role management (BE-16): a hospital's admin edits its roles.
--
-- Until now the app role could only read roles and their grants. It may now create a role,
-- rename a custom one, delete a custom one and change what any role holds. The grants are narrow
-- on purpose: a new row is never built-in, and a built-in role keeps its id and name.

GRANT INSERT (tenant_id, id, name) ON roles TO mediflow_app;
GRANT UPDATE (name, updated_at) ON roles TO mediflow_app;
GRANT DELETE ON roles TO mediflow_app;

GRANT INSERT, DELETE ON role_permissions TO mediflow_app;
GRANT UPDATE (scope) ON role_permissions TO mediflow_app;

-- A last line of defence behind the API: a hospital's requests (the app role) can neither
-- rename, re-identify nor delete a built-in role. Migrations, the platform's offboarding and the
-- cascade from a deleted hospital run as other roles and are not held back.
CREATE FUNCTION roles_protect_built_in() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user <> 'mediflow_app' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.built_in THEN
      RAISE EXCEPTION 'A built-in role cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.built_in AND (NEW.id <> OLD.id OR NEW.name <> OLD.name OR NOT NEW.built_in
                       OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'A built-in role keeps its id and name' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT OLD.built_in AND NEW.built_in THEN
    RAISE EXCEPTION 'A custom role cannot become built-in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER roles_protect_built_in BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION roles_protect_built_in();
