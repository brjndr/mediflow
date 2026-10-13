-- Diagnosis and procedure codes (BE-17e): the code sets a diagnosis or a procedure is recorded
-- with, and each hospital's favourites among them.

-- The codes are reference data shared by every hospital, so this table carries no tenant and no
-- row-level security: every hospital reads the same rows, and none can change them. A set is
-- loaded by an operator (`pnpm --filter api codes:load`), never by a request, and none is kept in
-- the repository: which edition a hospital uses is its own to license.
CREATE TABLE codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system text NOT NULL CHECK (system IN ('icd10', 'procedure')),
  -- As it is written: A09, E11.9.
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9.-]*$' AND length(code) <= 20),
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 300),
  -- Stored, so a search is a comparison on a column: the code without its dot, and the title in
  -- lower case.
  code_plain text GENERATED ALWAYS AS (lower(replace(code, '.', ''))) STORED,
  title_lower text GENERATED ALWAYS AS (lower(title)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One code of a set, as written. A set is loaded again by updating titles, never by removing a
  -- code: a diagnosis recorded with it, and a hospital's favourite, still name it.
  CONSTRAINT codes_system_code UNIQUE (system, code)
);

-- The codes of a set in order. Plain byte order, which is the order the sets are published in
-- (A00, A00.1, A01) and is the same on every database whatever its locale.
CREATE INDEX codes_in_order ON codes (system, code COLLATE "C", id);
-- A code typed from its start, with or without its dot.
CREATE INDEX codes_by_code_plain ON codes (system, code_plain text_pattern_ops);
-- A word of the title from its start. A text index is usable here, where it never is on a tenant
-- table: this table has no row-level security policy.
CREATE INDEX codes_by_title ON codes USING gin (title_lower gin_trgm_ops);

GRANT SELECT ON codes TO mediflow_app;

-- A hospital's own mark on a code, for every member of its staff: its favourites come first in
-- every list and search.
CREATE TABLE code_favourites (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code_id uuid NOT NULL REFERENCES codes (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code_id)
);

-- A mark is added and taken away; there is nothing in it to change.
SELECT enable_tenant_rls('code_favourites', 'SELECT, INSERT, DELETE');
