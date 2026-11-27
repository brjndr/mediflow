-- #1192: a role carries a version, so two administrators saving it at once cannot silently undo
-- each other. `PUT /roles/{roleId}` sends back the version it read.

ALTER TABLE roles ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE FUNCTION roles_count_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Whatever the statement set it to: the version is the database's to count.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER roles_count_version BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION roles_count_version();

-- A grant written by any path (the API, the default grants of a deploy, a migration) moves the
-- role on too, so an editor opened before it cannot take it back unseen. Only the version's being
-- different matters, so it may move by more than one for one save. A database role that may not
-- update roles (the platform's, which writes the grants of a new hospital) is left alone: no one
-- can be editing a role that is only now being made.
CREATE FUNCTION role_permissions_move_role() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF has_column_privilege('roles', 'updated_at', 'UPDATE') THEN
    IF TG_OP = 'DELETE' THEN
      UPDATE roles SET updated_at = now() WHERE tenant_id = OLD.tenant_id AND id = OLD.role_id;
    ELSE
      UPDATE roles SET updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = NEW.role_id;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER role_permissions_move_role AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION role_permissions_move_role();
