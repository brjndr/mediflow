-- Insurance (BE-28, #187), first slice: the organisations a hospital bills instead of the patient
-- (insurers, TPAs, corporates), their plans and rate agreements, a patient's policies and the
-- pre-authorizations asked of the payer. What the database itself guarantees:
--
-- * A payer's and a plan's code never change, and a plan belongs to one payer for good.
-- * A rate agreement is only ever ended: its terms never change, and the agreements of one payer
--   never overlap (an exclusion constraint on closed date ranges, no end meaning open-ended).
-- * A policy is only ended (once); nothing else about it changes.
-- * A pre-authorization is answered or withdrawn once, from `submitted`; its request never changes.
-- Every table carries tenant_id (defaulting to the session's hospital) and row-level security, and
-- every reference carries the hospital, since foreign keys are checked without row-level security.

CREATE FUNCTION insurance_touch() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'The hospital and id of a record cannot change' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- --- payers ----------------------------------------------------------------------------------

CREATE TABLE payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('insurer', 'tpa', 'corporate')),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(code) <= 20),
  code_lower text GENERATED ALWAYS AS (lower(code)) STORED,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  contact_name text CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 100),
  phone text CHECK (phone IS NULL OR length(phone) BETWEEN 1 AND 30),
  email text CHECK (email IS NULL OR length(email) BETWEEN 1 AND 100),
  address text CHECK (address IS NULL OR length(address) BETWEEN 1 AND 300),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payers_code_taken UNIQUE (tenant_id, code_lower),
  CONSTRAINT payers_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX payers_tenant_list ON payers (tenant_id, archived, name_lower, id);

CREATE FUNCTION payers_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'The code and kind of a payer do not change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payers_guard BEFORE UPDATE ON payers
  FOR EACH ROW EXECUTE FUNCTION payers_guard_update();
CREATE TRIGGER payers_touch BEFORE UPDATE ON payers
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('payers', 'SELECT, INSERT, UPDATE');

-- --- plans -----------------------------------------------------------------------------------

CREATE TABLE payer_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  payer_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(code) <= 20),
  code_lower text GENERATED ALWAYS AS (lower(code)) STORED,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  coverage_mode text NOT NULL CHECK (coverage_mode IN ('all_except', 'only_listed')),
  copay_percent integer NOT NULL CHECK (copay_percent BETWEEN 0 AND 100),
  sum_insured_minor bigint CHECK (sum_insured_minor IS NULL OR sum_insured_minor BETWEEN 0 AND 1000000000000),
  room_rent_limit_minor bigint CHECK (room_rent_limit_minor IS NULL OR room_rent_limit_minor BETWEEN 0 AND 1000000000000),
  pre_auth_required boolean NOT NULL,
  min_age integer CHECK (min_age IS NULL OR min_age BETWEEN 0 AND 120),
  max_age integer CHECK (max_age IS NULL OR max_age BETWEEN 0 AND 120),
  waiting_period_days integer CHECK (waiting_period_days IS NULL OR waiting_period_days BETWEEN 0 AND 3650),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payer_plans_ages CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CONSTRAINT payer_plans_payer FOREIGN KEY (tenant_id, payer_id) REFERENCES payers (tenant_id, id),
  CONSTRAINT payer_plans_code_taken UNIQUE (tenant_id, payer_id, code_lower),
  CONSTRAINT payer_plans_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX payer_plans_tenant_payer ON payer_plans (tenant_id, payer_id, name_lower, id);

CREATE FUNCTION payer_plans_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.payer_id IS DISTINCT FROM OLD.payer_id THEN
    RAISE EXCEPTION 'The code and payer of a plan do not change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payer_plans_guard BEFORE UPDATE ON payer_plans
  FOR EACH ROW EXECUTE FUNCTION payer_plans_guard_update();
CREATE TRIGGER payer_plans_touch BEFORE UPDATE ON payer_plans
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('payer_plans', 'SELECT, INSERT, UPDATE');

-- The services a plan lists (covered, or excluded, by its mode), with an optional limit each.
CREATE TABLE payer_plan_services (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  plan_id uuid NOT NULL,
  service_id uuid NOT NULL,
  limit_minor bigint CHECK (limit_minor IS NULL OR limit_minor BETWEEN 0 AND 1000000000000),
  PRIMARY KEY (tenant_id, plan_id, service_id),
  CONSTRAINT payer_plan_services_plan FOREIGN KEY (tenant_id, plan_id)
    REFERENCES payer_plans (tenant_id, id),
  CONSTRAINT payer_plan_services_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id)
);

SELECT enable_tenant_rls('payer_plan_services', 'SELECT, INSERT, UPDATE, DELETE');

-- --- rate agreements -------------------------------------------------------------------------

CREATE TABLE rate_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  payer_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  effective_from date NOT NULL,
  -- The last day it applies; NULL is until ended.
  effective_to date,
  discount_bp integer NOT NULL CHECK (discount_bp BETWEEN 0 AND 10000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_agreements_in_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT rate_agreements_payer FOREIGN KEY (tenant_id, payer_id) REFERENCES payers (tenant_id, id),
  CONSTRAINT rate_agreements_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT rate_agreements_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, payer_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
  )
);
CREATE INDEX rate_agreements_tenant_payer ON rate_agreements (tenant_id, payer_id, effective_from DESC);

CREATE FUNCTION rate_agreements_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['effective_to', 'version', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['effective_to', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A rate agreement is only ended, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rate_agreements_guard BEFORE UPDATE ON rate_agreements
  FOR EACH ROW EXECUTE FUNCTION rate_agreements_guard_update();
CREATE TRIGGER rate_agreements_touch BEFORE UPDATE ON rate_agreements
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('rate_agreements', 'SELECT, INSERT, UPDATE');

-- Written with the agreement and never changed or removed.
CREATE TABLE rate_agreement_rates (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  agreement_id uuid NOT NULL,
  service_id uuid NOT NULL,
  rate_minor bigint NOT NULL CHECK (rate_minor BETWEEN 0 AND 1000000000000),
  PRIMARY KEY (tenant_id, agreement_id, service_id),
  CONSTRAINT rate_agreement_rates_agreement FOREIGN KEY (tenant_id, agreement_id)
    REFERENCES rate_agreements (tenant_id, id),
  CONSTRAINT rate_agreement_rates_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id)
);

SELECT enable_tenant_rls('rate_agreement_rates', 'SELECT, INSERT');

-- --- patient policies ------------------------------------------------------------------------

CREATE TABLE patient_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  policy_number text NOT NULL CHECK (policy_number = btrim(policy_number) AND length(policy_number) BETWEEN 1 AND 40),
  member_id text CHECK (member_id IS NULL OR length(member_id) BETWEEN 1 AND 40),
  holder_name text NOT NULL CHECK (holder_name = btrim(holder_name) AND length(holder_name) BETWEEN 1 AND 100),
  relationship text NOT NULL CHECK (relationship IN ('self', 'spouse', 'child', 'parent', 'other')),
  valid_from date NOT NULL,
  valid_to date,
  ended_at timestamptz,
  ended_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_policies_in_order CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT patient_policies_ended CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CONSTRAINT patient_policies_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT patient_policies_plan FOREIGN KEY (tenant_id, plan_id)
    REFERENCES payer_plans (tenant_id, id),
  CONSTRAINT patient_policies_payer FOREIGN KEY (tenant_id, payer_id)
    REFERENCES payers (tenant_id, id),
  CONSTRAINT patient_policies_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT patient_policies_tenant_id_patient UNIQUE (tenant_id, id, patient_id)
);
CREATE INDEX patient_policies_tenant_patient ON patient_policies (tenant_id, patient_id, created_at DESC, id DESC);
-- The same card is on a patient's record once while it is in force.
CREATE UNIQUE INDEX patient_policies_in_force ON patient_policies (tenant_id, patient_id, plan_id, policy_number)
  WHERE ended_at IS NULL;

CREATE FUNCTION patient_policies_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['ended_at', 'ended_by', 'version', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['ended_at', 'ended_by', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A policy is only ended, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_policies_guard BEFORE UPDATE ON patient_policies
  FOR EACH ROW EXECUTE FUNCTION patient_policies_guard_update();
CREATE TRIGGER patient_policies_touch BEFORE UPDATE ON patient_policies
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('patient_policies', 'SELECT, INSERT, UPDATE');

-- --- pre-authorizations ----------------------------------------------------------------------

CREATE TABLE pre_auths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  patient_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  encounter_id uuid,
  treatment text NOT NULL CHECK (length(treatment) BETWEEN 1 AND 300),
  requested_minor bigint NOT NULL CHECK (requested_minor BETWEEN 0 AND 1000000000000),
  approved_minor bigint CHECK (approved_minor IS NULL OR approved_minor BETWEEN 0 AND 1000000000000),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'approved', 'rejected', 'cancelled')),
  reference_number text CHECK (reference_number IS NULL OR length(reference_number) BETWEEN 1 AND 60),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 300),
  -- Names of what is enclosed; the files are on the patient's record (documents).
  documents jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(documents) = 'array' AND jsonb_array_length(documents) <= 20),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL,
  decided_at timestamptz,
  decided_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pre_auths_approved CHECK ((status = 'approved') = (approved_minor IS NOT NULL)),
  CONSTRAINT pre_auths_decided CHECK ((status = 'submitted') = (decided_at IS NULL)),
  CONSTRAINT pre_auths_policy FOREIGN KEY (tenant_id, policy_id, patient_id)
    REFERENCES patient_policies (tenant_id, id, patient_id),
  CONSTRAINT pre_auths_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT pre_auths_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX pre_auths_tenant_patient ON pre_auths (tenant_id, patient_id, requested_at DESC, id DESC);
CREATE INDEX pre_auths_tenant_encounter ON pre_auths (tenant_id, encounter_id, requested_at DESC)
  WHERE encounter_id IS NOT NULL;

CREATE FUNCTION pre_auths_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'submitted'
     OR NEW.status = 'submitted'
     OR (to_jsonb(NEW) - ARRAY['status', 'approved_minor', 'reference_number', 'decision_note',
                               'decided_at', 'decided_by', 'version', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'approved_minor', 'reference_number', 'decision_note',
                               'decided_at', 'decided_by', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'A pre-authorization is answered or withdrawn once, from submitted'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pre_auths_guard BEFORE UPDATE ON pre_auths
  FOR EACH ROW EXECUTE FUNCTION pre_auths_guard_update();
CREATE TRIGGER pre_auths_touch BEFORE UPDATE ON pre_auths
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('pre_auths', 'SELECT, INSERT, UPDATE');
