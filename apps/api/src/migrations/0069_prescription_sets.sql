-- Prescription sets and favourite medicines (#394): a named list of medicine lines a doctor loads
-- into a prescription in one step, and the medicines a doctor reaches for first.
--
-- * A set belongs to the hospital (owner_user_id is NULL: shared with every prescriber) or to one
--   doctor. Its lines name a medicine of the catalog with dose, route, frequency, days, quantity
--   and instructions as a prescription line has them (same limits as the orders table, 0039). A set holds
--   no patient: loading it creates nothing, the doctor still prescribes and the usual checks run.
-- * Archived, never deleted: a medicine archived later stays on the set and is flagged on read.
-- * Favourites are per member of staff, in the order the doctor put them.

CREATE TABLE prescription_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  -- The doctor it belongs to; empty: shared with the hospital.
  owner_user_id uuid,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescription_sets_tenant_id_id UNIQUE (tenant_id, id)
);

-- A name is one set among the hospital's shared sets, and one among a doctor's own, archived or not.
CREATE UNIQUE INDEX prescription_sets_shared_name
  ON prescription_sets (tenant_id, name_lower) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX prescription_sets_own_name
  ON prescription_sets (tenant_id, owner_user_id, name_lower) WHERE owner_user_id IS NOT NULL;
-- The list: what a doctor may see, by name.
CREATE INDEX prescription_sets_list ON prescription_sets (tenant_id, archived, name_lower, id);

-- No DELETE: a set is archived.
SELECT enable_tenant_rls('prescription_sets', 'SELECT, INSERT, UPDATE');

CREATE TABLE prescription_set_lines (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  set_id uuid NOT NULL,
  line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 30),
  drug_id uuid NOT NULL,
  dose text NOT NULL CHECK (length(dose) BETWEEN 1 AND 50),
  route text NOT NULL CHECK (route IN (
    'oral', 'sublingual', 'topical', 'inhaled', 'nasal', 'eye', 'ear', 'rectal', 'vaginal',
    'intramuscular', 'intravenous', 'subcutaneous', 'other'
  )),
  frequency text NOT NULL CHECK (length(frequency) BETWEEN 1 AND 50),
  duration_days integer CHECK (duration_days BETWEEN 1 AND 365),
  quantity integer CHECK (quantity BETWEEN 1 AND 10000),
  instructions text CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, set_id, line_number),
  CONSTRAINT prescription_set_lines_set FOREIGN KEY (tenant_id, set_id)
    REFERENCES prescription_sets (tenant_id, id),
  CONSTRAINT prescription_set_lines_drug FOREIGN KEY (tenant_id, drug_id)
    REFERENCES drugs (tenant_id, id)
);

-- The lines of a set are replaced as a whole when it is edited.
SELECT enable_tenant_rls('prescription_set_lines', 'SELECT, INSERT, DELETE');

CREATE TABLE doctor_favourite_drugs (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  PRIMARY KEY (tenant_id, user_id, drug_id),
  CONSTRAINT doctor_favourite_drugs_place UNIQUE (tenant_id, user_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT doctor_favourite_drugs_drug FOREIGN KEY (tenant_id, drug_id)
    REFERENCES drugs (tenant_id, id)
);

SELECT enable_tenant_rls('doctor_favourite_drugs', 'SELECT, INSERT, DELETE');
