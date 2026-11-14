-- Peri-operative record of a surgery (#872): fitness for surgery, the checklist and the
-- anaesthesia record. Additive.
--
-- * Fitness is one row for each surgery, replaced by a new assessment (each is audited).
-- * A checklist step is done once and never changed or removed (insert-only, one row for each
--   step of a surgery); the server takes the time and the signer.
-- * The anaesthesia record is a draft that is replaced until it is signed, then never changed.

CREATE TABLE ot_fitness (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('fit', 'conditional', 'unfit')),
  notes text CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 500),
  assessed_by uuid NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, booking_id),
  CONSTRAINT ot_fitness_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
SELECT enable_tenant_rls('ot_fitness', 'SELECT, INSERT, UPDATE');

CREATE TABLE ot_checklist_steps (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('consent_confirmed', 'site_marked', 'fasting_confirmed',
    'identity_confirmed', 'anaesthesia_check_done', 'allergies_checked', 'team_introduced',
    'procedure_confirmed', 'antibiotic_given', 'counts_correct', 'specimens_labelled',
    'concerns_handed_over')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  completed_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, booking_id, step),
  CONSTRAINT ot_checklist_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
SELECT enable_tenant_rls('ot_checklist_steps', 'SELECT, INSERT');

CREATE TABLE ot_anaesthesia (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  booking_id uuid NOT NULL,
  technique text NOT NULL CHECK (technique IN ('general', 'spinal', 'epidural', 'regional', 'local', 'sedation')),
  asa_class integer NOT NULL CHECK (asa_class BETWEEN 1 AND 6),
  drugs text CHECK (drugs IS NULL OR char_length(drugs) BETWEEN 1 AND 1000),
  notes text CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 1000),
  saved_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  signed_by uuid,
  CONSTRAINT ot_anaesthesia_signed CHECK ((signed_at IS NULL) = (signed_by IS NULL)),
  PRIMARY KEY (tenant_id, booking_id),
  CONSTRAINT ot_anaesthesia_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES ot_bookings (tenant_id, id)
);
CREATE FUNCTION ot_anaesthesia_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A signed anaesthesia record is never changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ot_anaesthesia_guard BEFORE UPDATE ON ot_anaesthesia
  FOR EACH ROW EXECUTE FUNCTION ot_anaesthesia_guard();
SELECT enable_tenant_rls('ot_anaesthesia', 'SELECT, INSERT, UPDATE');
