-- Blood bank: recall of a reactive donor's units that were already cleared (#935).
--
-- A reactive screening takes the donor's available and reserved units out of use (discarded by the
-- API) and flags the ones already issued or transfused here, for a person at the blood bank to
-- follow up with the recipient's doctor. One flag per unit; only the follow-up columns can change,
-- once.

CREATE TABLE blood_unit_recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  blood_unit_id uuid NOT NULL,
  donor_id uuid NOT NULL,
  patient_id uuid,
  unit_status text NOT NULL CHECK (unit_status IN ('issued', 'transfused')),
  trigger_unit_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  flagged_by uuid NOT NULL,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  followed_up_by uuid,
  followed_up_at timestamptz,
  follow_up_note text CHECK (char_length(follow_up_note) BETWEEN 1 AND 2000),
  CONSTRAINT blood_unit_recalls_once UNIQUE (tenant_id, blood_unit_id),
  CONSTRAINT blood_unit_recalls_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT blood_unit_recalls_unit FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES blood_units (tenant_id, id),
  CONSTRAINT blood_unit_recalls_donor FOREIGN KEY (tenant_id, donor_id)
    REFERENCES blood_donors (tenant_id, id),
  CONSTRAINT blood_unit_recalls_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT blood_unit_recalls_followed CHECK (
    (followed_up_at IS NULL AND followed_up_by IS NULL AND follow_up_note IS NULL)
    OR (followed_up_at IS NOT NULL AND followed_up_by IS NOT NULL AND follow_up_note IS NOT NULL)
  )
);
CREATE INDEX blood_unit_recalls_listing ON blood_unit_recalls (tenant_id, flagged_at DESC, id DESC);
CREATE INDEX blood_unit_recalls_donor_idx ON blood_unit_recalls (tenant_id, donor_id);
SELECT enable_tenant_rls('blood_unit_recalls', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION blood_unit_recalls_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.blood_unit_id, NEW.donor_id, NEW.patient_id, NEW.unit_status,
      NEW.trigger_unit_id, NEW.reason, NEW.flagged_by, NEW.flagged_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.blood_unit_id, OLD.donor_id, OLD.patient_id, OLD.unit_status,
      OLD.trigger_unit_id, OLD.reason, OLD.flagged_by, OLD.flagged_at) THEN
    RAISE EXCEPTION 'A recall flag is not changed, only followed up';
  END IF;
  IF OLD.followed_up_at IS NOT NULL THEN
    RAISE EXCEPTION 'The recall has been followed up';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blood_unit_recalls_guard BEFORE UPDATE ON blood_unit_recalls
  FOR EACH ROW EXECUTE FUNCTION blood_unit_recalls_guard();
