-- Emergency cases (BE-26, #175).
--
-- * An emergency case is an arrival before any registration: it may name a patient on record or
--   stay unidentified under a temporary ID (ER-0042) issued from a per-hospital counter.
-- * Linking an unidentified case to a patient is recorded as a row in er_case_links, which stays
--   when the link is undone (within a window the API enforces), so the whole history is kept.
-- * The temporary ID, arrival time and author never change; the rest moves through the API.

CREATE TABLE er_counters (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants (id),
  last_no integer NOT NULL DEFAULT 0
);
SELECT enable_tenant_rls('er_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE er_encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  temp_no integer NOT NULL CHECK (temp_no >= 1),
  patient_id uuid,
  alias text CHECK (alias IS NULL OR char_length(alias) BETWEEN 1 AND 120),
  sex text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('male', 'female', 'other', 'unknown')),
  approximate_age integer CHECK (approximate_age IS NULL OR approximate_age BETWEEN 0 AND 130),
  complaint text NOT NULL CHECK (char_length(complaint) BETWEEN 1 AND 300),
  arrival_mode text NOT NULL CHECK (arrival_mode IN ('walk_in', 'ambulance', 'police', 'referred')),
  category integer CHECK (category IS NULL OR category BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_treatment', 'disposed')),
  arrived_at timestamptz NOT NULL DEFAULT now(),
  triaged_at timestamptz,
  identified_at timestamptz,
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT er_encounters_triaged CHECK ((category IS NULL) = (triaged_at IS NULL)),
  CONSTRAINT er_encounters_temp_no UNIQUE (tenant_id, temp_no),
  CONSTRAINT er_encounters_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT er_encounters_tenant_id_id UNIQUE (tenant_id, id)
);
-- The board: open cases, untriaged first, then by category and wait.
CREATE INDEX er_encounters_board ON er_encounters
  (tenant_id, status, (COALESCE(category, 0)), arrived_at, id);

CREATE FUNCTION er_encounters_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['patient_id', 'category', 'status', 'triaged_at', 'identified_at', 'version', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['patient_id', 'category', 'status', 'triaged_at', 'identified_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Only the triage, status and identity of a case change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'disposed' THEN
    RAISE EXCEPTION 'A case that has left the department is closed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER er_encounters_touch BEFORE UPDATE ON er_encounters
  FOR EACH ROW EXECUTE FUNCTION ops_touch();
CREATE TRIGGER er_encounters_guard BEFORE UPDATE ON er_encounters
  FOR EACH ROW EXECUTE FUNCTION er_encounters_guard();
SELECT enable_tenant_rls('er_encounters', 'SELECT, INSERT, UPDATE');

-- Who linked a case to which patient, and who undid it. A row is only ever closed, once.
CREATE TABLE er_case_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  case_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  undone_by uuid,
  undone_at timestamptz,
  undo_reason text CHECK (undo_reason IS NULL OR char_length(undo_reason) BETWEEN 1 AND 300),
  CONSTRAINT er_case_links_undone CHECK ((undone_by IS NULL) = (undone_at IS NULL)),
  CONSTRAINT er_case_links_case FOREIGN KEY (tenant_id, case_id)
    REFERENCES er_encounters (tenant_id, id),
  CONSTRAINT er_case_links_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id)
);
CREATE INDEX er_case_links_case ON er_case_links (tenant_id, case_id, linked_at);

CREATE FUNCTION er_case_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.undone_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['undone_by', 'undone_at', 'undo_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['undone_by', 'undone_at', 'undo_reason']) THEN
    RAISE EXCEPTION 'A link is only undone, once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER er_case_links_guard BEFORE UPDATE ON er_case_links
  FOR EACH ROW EXECUTE FUNCTION er_case_links_guard();
SELECT enable_tenant_rls('er_case_links', 'SELECT, INSERT, UPDATE');
