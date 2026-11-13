-- Insurance (BE-28, #187), second slice: the saved coverage split of a visit and the claims made
-- from it. What the database itself guarantees:
--
-- * A visit has one claim in play at a time (a partial unique index: cancelled and written-off
--   claims are out of play).
-- * A claim's visit, policy, payer, number and claimed amount never change; its money only moves
--   within what was claimed (received + written off <= claimed) and what was approved.
-- * Claim numbers are gapless within a hospital: the counter row is locked and moved in the
--   transaction that creates the claim.
-- * A claim's history is append-only.
-- Every table carries tenant_id (defaulting to the session's hospital) and row-level security.

CREATE TABLE coverage_splits (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  encounter_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  ledger_minor bigint NOT NULL CHECK (ledger_minor >= 0),
  payer_minor bigint NOT NULL CHECK (payer_minor >= 0),
  patient_minor bigint NOT NULL CHECK (patient_minor >= 0),
  saved_by uuid NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, encounter_id),
  CONSTRAINT coverage_splits_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  CONSTRAINT coverage_splits_policy FOREIGN KEY (tenant_id, policy_id)
    REFERENCES patient_policies (tenant_id, id)
);

SELECT enable_tenant_rls('coverage_splits', 'SELECT, INSERT, UPDATE');

CREATE TABLE claim_counters (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants (id),
  last_number integer NOT NULL CHECK (last_number >= 1)
);

SELECT enable_tenant_rls('claim_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  seq integer NOT NULL CHECK (seq >= 1),
  patient_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  -- The policy number as it was when the claim was prepared.
  policy_number text NOT NULL CHECK (length(policy_number) BETWEEN 1 AND 40),
  claimed_minor bigint NOT NULL CHECK (claimed_minor BETWEEN 1 AND 1000000000000),
  approved_minor bigint CHECK (approved_minor IS NULL OR approved_minor BETWEEN 0 AND 1000000000000),
  received_minor bigint NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  written_off_minor bigint NOT NULL DEFAULT 0 CHECK (written_off_minor >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'submitted', 'query', 'approved', 'rejected', 'settled', 'written_off', 'cancelled')),
  reference_number text CHECK (reference_number IS NULL OR length(reference_number) BETWEEN 1 AND 60),
  open_query text CHECK (open_query IS NULL OR length(open_query) BETWEEN 1 AND 500),
  -- Names of the packet; the files are on the patient's record (documents).
  documents jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(documents) = 'array' AND jsonb_array_length(documents) <= 20),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claims_money CHECK (received_minor + written_off_minor <= claimed_minor),
  CONSTRAINT claims_paid_within_approved CHECK (received_minor <= COALESCE(approved_minor, 0)),
  CONSTRAINT claims_query_open CHECK ((status = 'query') = (open_query IS NOT NULL)),
  CONSTRAINT claims_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id),
  CONSTRAINT claims_encounter FOREIGN KEY (tenant_id, encounter_id, patient_id)
    REFERENCES encounters (tenant_id, id, patient_id),
  CONSTRAINT claims_policy FOREIGN KEY (tenant_id, policy_id, patient_id)
    REFERENCES patient_policies (tenant_id, id, patient_id),
  CONSTRAINT claims_payer FOREIGN KEY (tenant_id, payer_id) REFERENCES payers (tenant_id, id),
  CONSTRAINT claims_number_taken UNIQUE (tenant_id, seq),
  CONSTRAINT claims_tenant_id_id UNIQUE (tenant_id, id)
);
CREATE INDEX claims_tenant_list ON claims (tenant_id, seq DESC);
CREATE INDEX claims_tenant_status ON claims (tenant_id, status, seq DESC);
-- One claim in play for a visit.
CREATE UNIQUE INDEX claims_one_open_per_visit ON claims (tenant_id, encounter_id)
  WHERE status NOT IN ('cancelled', 'written_off');

CREATE FUNCTION claims_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approved_minor', 'received_minor', 'written_off_minor', 'status',
        'reference_number', 'open_query', 'documents', 'submitted_at', 'decided_at', 'version',
        'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['approved_minor', 'received_minor', 'written_off_minor', 'status',
        'reference_number', 'open_query', 'documents', 'submitted_at', 'decided_at', 'version',
        'updated_at']) THEN
    RAISE EXCEPTION 'The visit, policy, payer, number and claimed amount of a claim do not change'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'A cancelled or written-off claim is not changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER claims_guard BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION claims_guard_update();
CREATE TRIGGER claims_touch BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION insurance_touch();

SELECT enable_tenant_rls('claims', 'SELECT, INSERT, UPDATE');

-- What happened to a claim, never changed or removed.
CREATE TABLE claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  claim_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN
    ('create', 'submit', 'raise_query', 'reply', 'approve', 'reject', 'settle', 'write_off', 'cancel')),
  to_status text NOT NULL CHECK (to_status IN
    ('draft', 'submitted', 'query', 'approved', 'rejected', 'settled', 'written_off', 'cancelled')),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  actor_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_events_claim FOREIGN KEY (tenant_id, claim_id) REFERENCES claims (tenant_id, id)
);
CREATE INDEX claim_events_claim ON claim_events (tenant_id, claim_id, at, id);

SELECT enable_tenant_rls('claim_events', 'SELECT, INSERT');
