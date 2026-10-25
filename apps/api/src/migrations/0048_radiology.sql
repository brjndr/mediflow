-- Radiology (#96): the modality of an imaging service, and the study of an imaging order, which
-- is scheduled, then performed. What the database itself guarantees:
--
-- * Only an imaging service has a modality.
-- * An order has at most one study, which names its order, encounter, patient and service
--   together, so it cannot be filed under another patient or visit.
-- * A study is performed only once it is scheduled, and once performed nothing of it changes.
--   What it is of never changes, and it is never removed: unscheduling clears its time.

ALTER TABLE services
  ADD COLUMN modality text CHECK (modality IN (
    'xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy', 'nuclear', 'other'
  )),
  ADD CONSTRAINT services_modality_imaging CHECK (modality IS NULL OR category = 'imaging');

-- So a study can name its order with the encounter, patient and service together.
ALTER TABLE orders
  ADD CONSTRAINT orders_tenant_id_service UNIQUE (tenant_id, id, encounter_id, patient_id, service_id);

-- Radiology's worklist: the hospital's imaging orders still open, oldest first.
CREATE INDEX orders_tenant_imaging_open ON orders (tenant_id, placed_at, id)
  WHERE type = 'imaging' AND status NOT IN ('cancelled', 'completed');

CREATE TABLE imaging_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  -- Copied from the order, so a report and the audit reach them without the clinical tables.
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  service_id uuid NOT NULL,
  -- The service's modality when the study was first scheduled; `other` when it had none.
  modality text NOT NULL CHECK (modality IN (
    'xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy', 'nuclear', 'other'
  )),
  -- The start of the slot. Null once unscheduled, until it is scheduled again.
  scheduled_at timestamptz,
  scheduled_by uuid,
  performed_at timestamptz,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT imaging_studies_scheduled CHECK ((scheduled_at IS NULL) = (scheduled_by IS NULL)),
  CONSTRAINT imaging_studies_performed CHECK (
    (performed_at IS NULL) = (performed_by IS NULL)
    AND (performed_at IS NULL OR scheduled_at IS NOT NULL)
  ),
  CONSTRAINT imaging_studies_order FOREIGN KEY (tenant_id, order_id, encounter_id, patient_id, service_id)
    REFERENCES orders (tenant_id, id, encounter_id, patient_id, service_id),
  CONSTRAINT imaging_studies_one_per_order UNIQUE (tenant_id, order_id),
  -- So a report can name a study together with its order, encounter and patient.
  CONSTRAINT imaging_studies_tenant_id_id UNIQUE (tenant_id, id, order_id, encounter_id, patient_id)
);

-- No DELETE: unscheduling clears the time, and a performed study stays.
SELECT enable_tenant_rls('imaging_studies', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION imaging_studies_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id
     OR NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.service_id <> OLD.service_id OR NEW.modality <> OLD.modality
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'What a study is of never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.performed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A performed study does not change' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imaging_studies_guard_update BEFORE UPDATE ON imaging_studies
  FOR EACH ROW EXECUTE FUNCTION imaging_studies_guard_update();
