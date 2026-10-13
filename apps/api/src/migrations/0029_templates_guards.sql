-- Document templates (BE-17f): two guards 0028 left to the code.
--
-- A template is added as its version 1. Without this a template could be inserted at a higher
-- number with only a version 1 beneath it, and that version, which is its newest, redacted: the
-- rule that the newest version is never redacted asks whether the template's number is higher.
CREATE FUNCTION templates_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> 1 THEN
    RAISE EXCEPTION 'A template is added as its version 1' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER templates_guard_insert
  BEFORE INSERT ON templates
  FOR EACH ROW EXECUTE FUNCTION templates_guard_insert();

-- A redaction is dated by the database, never by whoever makes it.
CREATE OR REPLACE FUNCTION template_versions_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.template_id <> OLD.template_id
    OR NEW.version <> OLD.version OR NEW.saved_at <> OLD.saved_at OR NEW.saved_by <> OLD.saved_by
    OR OLD.redacted_at IS NOT NULL OR NEW.redacted_at IS NULL THEN
    RAISE EXCEPTION 'A saved version of a template is never changed' USING ERRCODE = '42501';
  END IF;
  -- The newest version is the template as it is used: it is replaced by a new version first.
  IF NOT EXISTS (
    SELECT 1 FROM templates t
    WHERE t.tenant_id = OLD.tenant_id AND t.id = OLD.template_id AND t.version > OLD.version
  ) THEN
    RAISE EXCEPTION 'The newest version of a template is not redacted' USING ERRCODE = '42501';
  END IF;
  NEW.redacted_at := now();
  RETURN NEW;
END;
$$;
