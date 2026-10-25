-- Radiology reports (#97): the report of a performed imaging study, a draft until a radiologist
-- signs it, then never changed; a correction or a later finding is an addendum, signed in its
-- turn and never changed either. And the template kind a report is written from. What the
-- database itself guarantees:
--
-- * A study has at most one report, which names its study, order, encounter and patient together.
-- * A signed report never changes and nothing of what it is of ever does; no report is removed.
-- * An addendum is of a signed report, is only ever added, and is never changed or removed.

ALTER TABLE templates DROP CONSTRAINT templates_kind_check;
ALTER TABLE templates ADD CONSTRAINT templates_kind_check
  CHECK (kind IN ('prescription', 'clinical_note', 'consent', 'discharge_summary', 'imaging_report'));

CREATE TABLE imaging_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  study_id uuid NOT NULL,
  order_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- The app's rich text documents, reduced to its allowlist by the API. Technique may be empty.
  technique jsonb NOT NULL,
  findings jsonb NOT NULL,
  impression jsonb NOT NULL,
  -- Links to images held elsewhere: [{ "label": text, "url": https }], at most 10.
  links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 10),
  -- The template and version the findings were last filled from, if any.
  template_id uuid,
  template_version integer CHECK (template_version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  signed_by uuid,
  signed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT imaging_reports_template CHECK ((template_id IS NULL) = (template_version IS NULL)),
  CONSTRAINT imaging_reports_signed CHECK (
    (status = 'signed') = (signed_at IS NOT NULL) AND (signed_at IS NULL) = (signed_by IS NULL)
  ),
  CONSTRAINT imaging_reports_study FOREIGN KEY (tenant_id, study_id, order_id, encounter_id, patient_id)
    REFERENCES imaging_studies (tenant_id, id, order_id, encounter_id, patient_id),
  CONSTRAINT imaging_reports_one_per_study UNIQUE (tenant_id, study_id),
  CONSTRAINT imaging_reports_tenant_id_id UNIQUE (tenant_id, id)
);

-- The reported stage of the worklist: the newest signed first.
CREATE INDEX imaging_reports_tenant_signed ON imaging_reports (tenant_id, signed_at DESC, order_id DESC)
  WHERE status = 'signed';

-- No DELETE: a draft stays until it is signed, and a signed report stays.
SELECT enable_tenant_rls('imaging_reports', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION imaging_reports_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.study_id <> OLD.study_id
     OR NEW.order_id <> OLD.order_id OR NEW.encounter_id <> OLD.encounter_id
     OR NEW.patient_id <> OLD.patient_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'What a report is of never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'A signed report does not change' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER imaging_reports_guard_update BEFORE UPDATE ON imaging_reports
  FOR EACH ROW EXECUTE FUNCTION imaging_reports_guard_update();

CREATE TABLE imaging_report_addenda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  report_id uuid NOT NULL,
  body jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'correction', 'additional_finding', 'clarification', 'comparison', 'other'
  )),
  signed_by uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imaging_report_addenda_report FOREIGN KEY (tenant_id, report_id)
    REFERENCES imaging_reports (tenant_id, id)
);

CREATE INDEX imaging_report_addenda_tenant_report ON imaging_report_addenda (tenant_id, report_id, signed_at, id);

-- Append-only: no UPDATE or DELETE grant, and the trigger refuses either to the owner as well.
SELECT enable_tenant_rls('imaging_report_addenda', 'SELECT, INSERT');

CREATE FUNCTION imaging_report_addenda_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An addendum never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM imaging_reports r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.report_id AND r.status = 'signed'
  ) THEN
    RAISE EXCEPTION 'An addendum is of a signed report' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imaging_report_addenda_guard BEFORE INSERT OR UPDATE OR DELETE ON imaging_report_addenda
  FOR EACH ROW EXECUTE FUNCTION imaging_report_addenda_guard();
