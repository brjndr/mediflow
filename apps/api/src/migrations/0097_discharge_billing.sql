-- Discharge and inpatient billing (#169, BE-25).
--
-- * `discharge_plans` and `discharge_clearances`: the advice written for the patient and, for
--   each of nursing, pharmacy and the laboratory, whether the department has cleared the
--   discharge, with who and when. A row exists only once someone has written to it; a stay
--   with none has nothing cleared. Mutable (a clearance can be reopened), audited by the API.
-- * `stay_bill_estimates`: what the stay is expected to cost, one row for each admission.
-- * `deposits`, `deposit_applications`, `deposit_refunds`: the deposit ledger of a stay. All
--   three are append-only; what is held is what was taken less what was set against an invoice
--   and what was paid back. A deposit taken in cash, and one paid back in cash, go through the
--   caller's register session as a payment does.
-- * `billing_settings.discharge_policy`: how the hospital gates discharge on the bill.

CREATE TABLE discharge_plans (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  advice text CHECK (advice IS NULL OR length(advice) BETWEEN 1 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, admission_id),
  CONSTRAINT discharge_plans_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
);

SELECT enable_tenant_rls('discharge_plans', 'SELECT, INSERT, UPDATE');

CREATE TABLE discharge_clearances (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('nursing', 'pharmacy', 'lab')),
  status text NOT NULL CHECK (status IN ('pending', 'cleared')),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, admission_id, kind),
  CONSTRAINT discharge_clearances_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  CONSTRAINT discharge_clearances_note CHECK (status = 'cleared' OR note IS NULL)
);

SELECT enable_tenant_rls('discharge_clearances', 'SELECT, INSERT, UPDATE');

CREATE TABLE stay_bill_estimates (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, admission_id),
  CONSTRAINT stay_bill_estimates_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id)
);

SELECT enable_tenant_rls('stay_bill_estimates', 'SELECT, INSERT, UPDATE');

CREATE TABLE deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank', 'other')),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  session_id uuid,
  recorded_by uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposits_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT deposits_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  CONSTRAINT deposits_session FOREIGN KEY (tenant_id, session_id)
    REFERENCES cash_register_sessions (tenant_id, id),
  CONSTRAINT deposits_cash_session CHECK ((method = 'cash') = (session_id IS NOT NULL))
);

CREATE INDEX deposits_tenant_admission ON deposits (tenant_id, admission_id, at DESC, id DESC);
CREATE INDEX deposits_tenant_session ON deposits (tenant_id, session_id) WHERE session_id IS NOT NULL;

SELECT enable_tenant_rls('deposits', 'SELECT, INSERT');

CREATE TABLE deposit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  applied_by uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_applications_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  CONSTRAINT deposit_applications_payment FOREIGN KEY (tenant_id, payment_id, invoice_id)
    REFERENCES payments (tenant_id, id, invoice_id),
  CONSTRAINT deposit_applications_one_payment UNIQUE (tenant_id, payment_id)
);

CREATE INDEX deposit_applications_tenant_admission ON deposit_applications (tenant_id, admission_id);

SELECT enable_tenant_rls('deposit_applications', 'SELECT, INSERT');

CREATE TABLE deposit_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank', 'other')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  session_id uuid,
  refunded_by uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_refunds_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  CONSTRAINT deposit_refunds_session FOREIGN KEY (tenant_id, session_id)
    REFERENCES cash_register_sessions (tenant_id, id),
  CONSTRAINT deposit_refunds_cash_session CHECK ((method = 'cash') = (session_id IS NOT NULL))
);

CREATE INDEX deposit_refunds_tenant_admission ON deposit_refunds (tenant_id, admission_id);
CREATE INDEX deposit_refunds_tenant_session ON deposit_refunds (tenant_id, session_id) WHERE session_id IS NOT NULL;

SELECT enable_tenant_rls('deposit_refunds', 'SELECT, INSERT');

ALTER TABLE billing_settings
  ADD COLUMN discharge_policy text NOT NULL DEFAULT 'warn'
    CHECK (discharge_policy IN ('off', 'warn', 'block'));

-- The discharge summary (DS-02): six plain-text sections, a draft until signed. A signed summary
-- is never changed again (the trigger); a correction is an addendum, appended and never edited.
CREATE TABLE discharge_summaries (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  diagnoses text NOT NULL DEFAULT '' CHECK (length(diagnoses) <= 4000),
  procedures text NOT NULL DEFAULT '' CHECK (length(procedures) <= 4000),
  course text NOT NULL DEFAULT '' CHECK (length(course) <= 4000),
  results text NOT NULL DEFAULT '' CHECK (length(results) <= 4000),
  medicines text NOT NULL DEFAULT '' CHECK (length(medicines) <= 4000),
  follow_up text NOT NULL DEFAULT '' CHECK (length(follow_up) <= 4000),
  template_id uuid,
  template_version integer CHECK (template_version IS NULL OR template_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  signed_by uuid,
  signed_at timestamptz,
  PRIMARY KEY (tenant_id, admission_id),
  CONSTRAINT discharge_summaries_admission FOREIGN KEY (tenant_id, admission_id)
    REFERENCES admissions (tenant_id, id),
  CONSTRAINT discharge_summaries_template FOREIGN KEY (tenant_id, template_id)
    REFERENCES templates (tenant_id, id),
  CONSTRAINT discharge_summaries_template_pair CHECK ((template_id IS NULL) = (template_version IS NULL)),
  CONSTRAINT discharge_summaries_signed CHECK (
    (status = 'signed') = (signed_by IS NOT NULL AND signed_at IS NOT NULL)
  )
);

SELECT enable_tenant_rls('discharge_summaries', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION discharge_summaries_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'A signed discharge summary is never changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER discharge_summaries_guard BEFORE UPDATE ON discharge_summaries
  FOR EACH ROW EXECUTE FUNCTION discharge_summaries_guard();

CREATE TABLE discharge_summary_addenda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  admission_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  author_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discharge_summary_addenda_summary FOREIGN KEY (tenant_id, admission_id)
    REFERENCES discharge_summaries (tenant_id, admission_id)
);

CREATE INDEX discharge_summary_addenda_tenant_admission
  ON discharge_summary_addenda (tenant_id, admission_id, created_at, id);

SELECT enable_tenant_rls('discharge_summary_addenda', 'SELECT, INSERT');
