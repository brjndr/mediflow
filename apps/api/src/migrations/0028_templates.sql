-- Document templates (BE-17f): each hospital's own texts for a prescription, a clinical note, a
-- consent form and a discharge summary. A template is a blank form with placeholders and holds no
-- patient data. It is kept in versions that are never changed: a document made from a template
-- records the version it used.

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Decides which placeholders the text may use. Never changes (the trigger below).
  kind text NOT NULL CHECK (kind IN ('prescription', 'clinical_note', 'consent', 'discharge_summary')),
  -- The name, the number and the time of the newest version, kept here so that the list, its
  -- order and the rule that a name is one template of its kind are plain comparisons on a column.
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  saved_at timestamptz NOT NULL DEFAULT now(),
  -- Archived, never deleted: documents made from it name it.
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  -- A name is one template of its kind at a hospital, whatever its capitals, archived or not.
  CONSTRAINT templates_name_taken UNIQUE (tenant_id, kind, name_lower),
  -- So a version, and later a document, refers to a template together with the hospital.
  CONSTRAINT templates_tenant_id_id UNIQUE (tenant_id, id)
);

-- The list: a hospital's active (or archived) templates in name order.
CREATE INDEX templates_tenant_list ON templates (tenant_id, archived, name_lower, id);

-- No DELETE for the app role.
SELECT enable_tenant_rls('templates', 'SELECT, INSERT, UPDATE');

-- Every version a template has had. Append-only: a row is added and never changed, with one
-- exception, the redaction below.
CREATE TABLE template_versions (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- Empty only once the version is redacted.
  name text NOT NULL CHECK (name = btrim(name) AND length(name) <= 100),
  -- The rich text document of the app, reduced to its allowlist by the API. Never HTML.
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  saved_at timestamptz NOT NULL DEFAULT now(),
  saved_by uuid NOT NULL,
  -- A redaction (#292): someone typed what should never have been in a template, a real
  -- patient's details say. The name and the text of that version are blanked; the row, its
  -- number, who saved it and when stay, with who redacted it, when and why. The reason is from a
  -- list, so that it cannot itself hold what was removed.
  redacted_at timestamptz,
  redacted_by uuid,
  redaction_reason text
    CHECK (redaction_reason IN ('patient_data', 'personal_data', 'confidential', 'other')),
  PRIMARY KEY (tenant_id, template_id, version),
  -- The references carry the hospital: foreign keys are checked without row-level security.
  CONSTRAINT template_versions_template FOREIGN KEY (tenant_id, template_id)
    REFERENCES templates (tenant_id, id),
  CONSTRAINT template_versions_saved_by FOREIGN KEY (tenant_id, saved_by)
    REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT template_versions_redacted_by FOREIGN KEY (tenant_id, redacted_by)
    REFERENCES memberships (tenant_id, user_id),
  -- A version has its name and text, or it is redacted and has neither.
  CONSTRAINT template_versions_redaction CHECK (
    (redacted_at IS NULL AND redacted_by IS NULL AND redaction_reason IS NULL AND name <> '')
    OR (redacted_at IS NOT NULL AND redacted_by IS NOT NULL AND redaction_reason IS NOT NULL
        AND name = '' AND body = '{"type": "doc", "content": []}'::jsonb)
  )
);

-- No DELETE for the app role, and of UPDATE only the columns a redaction writes.
SELECT enable_tenant_rls('template_versions', 'SELECT, INSERT');
GRANT UPDATE (name, body, redacted_at, redacted_by, redaction_reason) ON template_versions
  TO mediflow_app;

-- A saved version is never changed, whoever asks, except to redact it, once.
CREATE FUNCTION template_versions_guard_update() RETURNS trigger
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER template_versions_guard_update
  BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_versions_guard_update();

-- A new version is the next number, and nothing else: none is skipped and none is put in behind
-- the newest.
CREATE FUNCTION template_versions_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  newest integer;
BEGIN
  SELECT max(version) INTO newest FROM template_versions
    WHERE tenant_id = NEW.tenant_id AND template_id = NEW.template_id;
  IF NEW.version <> coalesce(newest, 0) + 1 THEN
    RAISE EXCEPTION 'A version of a template is the next number' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER template_versions_guard_insert
  BEFORE INSERT ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_versions_guard_insert();

-- A template keeps its hospital and its kind. Its name, number and time move only to those of a
-- version that was saved: the next one.
CREATE FUNCTION templates_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A template keeps its hospital and its kind' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version OR NEW.name <> OLD.name OR NEW.saved_at <> OLD.saved_at THEN
    IF NEW.version <> OLD.version + 1 OR NOT EXISTS (
      SELECT 1 FROM template_versions v
      WHERE v.tenant_id = NEW.tenant_id AND v.template_id = NEW.id AND v.version = NEW.version
        AND v.name = NEW.name AND v.saved_at = NEW.saved_at
    ) THEN
      RAISE EXCEPTION 'A template is named and numbered by its newest version'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER templates_guard_update
  BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION templates_guard_update();
