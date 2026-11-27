-- Taking back what should not be billed (#1240). A pending charge on no draft is voided by hand,
-- and a draft invoice is discarded: it becomes void without ever having had a number, and keeps
-- its lines. Both say who, when and why (a fixed code, never free text). Additive.

ALTER TABLE charges
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid,
  ADD COLUMN void_reason text CHECK (void_reason IN
    ('entered_in_error', 'duplicate', 'not_performed', 'not_chargeable', 'other')),
  ADD CONSTRAINT charges_voided_whole CHECK (
    (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)
  ),
  ADD CONSTRAINT charges_voided_void CHECK (voided_at IS NULL OR status = 'void');

ALTER TABLE invoices
  ADD COLUMN discarded_at timestamptz,
  ADD COLUMN discarded_by uuid,
  ADD COLUMN discard_reason text CHECK (discard_reason IN
    ('made_in_error', 'duplicate', 'charges_changed', 'not_needed', 'other')),
  ADD CONSTRAINT invoices_discarded_whole CHECK (
    (discarded_at IS NULL) = (discarded_by IS NULL)
    AND (discarded_at IS NULL) = (discard_reason IS NULL)
  ),
  ADD CONSTRAINT invoices_discarded_void CHECK (discarded_at IS NULL OR status = 'void');

-- A void invoice was either issued (credited in full since) or discarded as a draft: a draft and
-- a discarded one have no number, every other invoice has one.
ALTER TABLE invoices DROP CONSTRAINT invoices_issued;
ALTER TABLE invoices ADD CONSTRAINT invoices_issued CHECK (
  CASE WHEN status = 'draft' OR discarded_at IS NOT NULL
    THEN number IS NULL AND issued_at IS NULL AND issued_by IS NULL AND fiscal_year IS NULL
    ELSE number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL
      AND fiscal_year IS NOT NULL
  END
);

-- Why a charge was voided is written once.
CREATE FUNCTION charges_void_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'void' AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at
    OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
    OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'Why a charge was voided is never changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER charges_void_guard BEFORE UPDATE ON charges
  FOR EACH ROW EXECUTE FUNCTION charges_void_guard();

-- A draft is discarded whatever its discount waits for; once discarded it is void, and a void
-- invoice never changes (the last check below).
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.encounter_id <> OLD.encounter_id
    OR NEW.patient_id <> OLD.patient_id OR NEW.currency <> OLD.currency
    OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'An invoice keeps its visit, patient and currency' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' AND NEW.discarded_at IS NULL
      AND NEW.discount_status = 'pending' THEN
      RAISE EXCEPTION 'A discount above the limit is approved before the invoice is issued'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor <> OLD.total_minor
    OR NEW.tax_minor <> OLD.tax_minor OR NEW.discount_minor <> OLD.discount_minor
    OR NEW.discount_status IS DISTINCT FROM OLD.discount_status
    OR NEW.bill_discount_bp IS DISTINCT FROM OLD.bill_discount_bp
    OR NEW.bill_discount_amount_minor IS DISTINCT FROM OLD.bill_discount_amount_minor
    OR NEW.bill_discount_reason IS DISTINCT FROM OLD.bill_discount_reason
    OR NEW.discount_applied_by IS DISTINCT FROM OLD.discount_applied_by
    OR NEW.discount_approved_by IS DISTINCT FROM OLD.discount_approved_by
    OR NEW.discount_approved_at IS DISTINCT FROM OLD.discount_approved_at
    OR NEW.discount_approved_minor IS DISTINCT FROM OLD.discount_approved_minor
    OR NEW.discount_approved_gross_minor IS DISTINCT FROM OLD.discount_approved_gross_minor
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year THEN
    RAISE EXCEPTION 'An issued invoice is never changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'draft' OR OLD.status = 'void' THEN
    RAISE EXCEPTION 'An issued invoice does not go back' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
