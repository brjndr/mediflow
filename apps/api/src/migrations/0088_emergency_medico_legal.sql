-- Medico-legal records of emergency cases (ER-03, #173).
--
-- A case is flagged medico-legal by recording its details. The record is never overwritten: every
-- change is a new revision (insert only, so what was written first stays on file), and the latest
-- revision is the current one. Reading it needs its own permission and is audited by the API.

CREATE TABLE er_medico_legal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  case_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  category text NOT NULL CHECK (category IN (
    'road_accident', 'assault', 'firearm_injury', 'burns', 'poisoning', 'sexual_assault',
    'suspected_abuse', 'suspicious_death', 'other')),
  narrative text NOT NULL CHECK (char_length(narrative) BETWEEN 1 AND 2000),
  brought_by text CHECK (brought_by IS NULL OR char_length(brought_by) BETWEEN 1 AND 120),
  police_informed boolean NOT NULL,
  police_station text CHECK (police_station IS NULL OR char_length(police_station) BETWEEN 1 AND 120),
  police_reference text CHECK (police_reference IS NULL OR char_length(police_reference) BETWEEN 1 AND 60),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT er_medico_legal_station CHECK (NOT police_informed OR police_station IS NOT NULL),
  CONSTRAINT er_medico_legal_revision UNIQUE (tenant_id, case_id, revision),
  CONSTRAINT er_medico_legal_case FOREIGN KEY (tenant_id, case_id)
    REFERENCES er_encounters (tenant_id, id)
);
SELECT enable_tenant_rls('er_medico_legal', 'SELECT, INSERT');
