-- A record of each load of a code set (#316): which set, which file (its SHA-256), what the load
-- did, when, and as which database login. Until now only `updated_at` on a code said that
-- something had changed, and nothing said from which file.
--
-- Written by the loader in the load's own transaction, so a load that fails, and a dry run,
-- leave no row. Shared like `codes`, with no tenant: a set is loaded for every hospital. No
-- grant to the app role: a hospital's requests have no business with it.
CREATE TABLE code_loads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system text NOT NULL CHECK (system IN ('icd10', 'procedure')),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  read integer NOT NULL CHECK (read >= 0),
  added integer NOT NULL CHECK (added >= 0),
  retitled integer NOT NULL CHECK (retitled >= 0),
  unchanged integer NOT NULL CHECK (unchanged >= 0),
  CONSTRAINT code_loads_counts CHECK (added + retitled + unchanged = read),
  loaded_at timestamptz NOT NULL DEFAULT now(),
  -- The login, not the role it may have set: whoever connected.
  loaded_by text NOT NULL DEFAULT session_user
);

CREATE INDEX code_loads_system_loaded_at ON code_loads (system, loaded_at);
