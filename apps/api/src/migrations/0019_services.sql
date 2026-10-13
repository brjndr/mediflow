-- Services and prices (BE-17a): what a hospital charges for, and what each costs on a price list
-- from a date. Reference data: no patient data in it. A charge will keep the price, the tax class
-- and the category it was posted with, so nothing here changes an old bill.

-- A hospital's price lists. Every hospital has one standard list; lists for a payer or a room
-- class come later, which is why a price names its list.
CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  -- The list used when none is named.
  standard boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_lists_name_taken UNIQUE (tenant_id, name),
  -- So a price refers to a list together with its hospital (see departments, migration 0014).
  CONSTRAINT price_lists_tenant_id_id UNIQUE (tenant_id, id)
);

-- One standard list per hospital.
CREATE UNIQUE INDEX price_lists_one_standard ON price_lists (tenant_id) WHERE standard;

-- Read-only for the app role: a list is made with its hospital, below.
SELECT enable_tenant_rls('price_lists', 'SELECT');

-- A new hospital gets its standard list, as it gets its built-in roles (migration 0006).
CREATE FUNCTION tenants_seed_price_list() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  INSERT INTO price_lists (tenant_id, name, standard) VALUES (NEW.id, 'Standard', true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_seed_price_list AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_seed_price_list();

-- The hospitals that exist already.
INSERT INTO price_lists (tenant_id, name, standard)
SELECT id, 'Standard', true FROM tenants;

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- The service's identity on bills. Never changes (the trigger below).
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(code) <= 30),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 150),
  -- Stored, so uniqueness, ordering and search are plain comparisons on a column: a function in
  -- the comparison could not use an index under row-level security.
  code_lower text GENERATED ALWAYS AS (lower(code)) STORED,
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  search_text text GENERATED ALWAYS AS (lower(code) || ' ' || lower(name)) STORED,
  category text NOT NULL
    CHECK (category IN ('consultation', 'procedure', 'bed', 'lab', 'imaging', 'package')),
  -- Which tax rate applies, as a class. The rate of each class is the hospital's tax setting.
  tax_class text NOT NULL CHECK (tax_class IN ('exempt', 'reduced', 'standard', 'higher')),
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  -- Archived, never deleted: it stays on the charges that name it and is no longer offered.
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One service of a code per hospital, whatever its capitals, archived or not.
  CONSTRAINT services_code_taken UNIQUE (tenant_id, code_lower),
  CONSTRAINT services_tenant_id_id UNIQUE (tenant_id, id)
);

-- The list: a hospital's active (or archived) services in name order.
CREATE INDEX services_tenant_list ON services (tenant_id, archived, name_lower, id);

-- No DELETE for the app role.
SELECT enable_tenant_rls('services', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION services_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
    OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'A service''s hospital, identity and code cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  -- Whatever the statement set it to: the version is the database's to count.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER services_guard_update BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION services_guard_update();

-- What a service costs on one price list from one date. A price is never edited: a new one takes
-- over from its own date and the one before it ends the day before.
CREATE TABLE service_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  service_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  -- In the minor unit of the hospital's currency.
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 1000000000000),
  -- Calendar dates at the hospital. effective_to is the last day the price applies, and is
  -- empty while no later price follows.
  effective_from date NOT NULL,
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A price that had not started can be withdrawn. The row is kept and no longer counts.
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Together with the hospital: foreign keys are checked without row-level security.
  CONSTRAINT service_prices_service FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  CONSTRAINT service_prices_price_list FOREIGN KEY (tenant_id, price_list_id)
    REFERENCES price_lists (tenant_id, id) ON DELETE CASCADE,
  -- Whatever the code does, a service never has two prices on one list for the same day.
  CONSTRAINT service_prices_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    service_id WITH =,
    price_list_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (withdrawn_at IS NULL)
);

-- The prices of a service on a list, newest first, and the one in force on a date.
CREATE INDEX service_prices_tenant_service ON service_prices
  (tenant_id, service_id, price_list_id, effective_from DESC, id);

-- No DELETE for the app role: a price is history, and a withdrawn one is marked, not removed.
SELECT enable_tenant_rls('service_prices', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION service_prices_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  today date;
BEGIN
  -- The only things that happen to a price: it gets (or loses) its last day when a later price
  -- arrives (or is withdrawn), and it is withdrawn.
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.service_id <> OLD.service_id
    OR NEW.price_list_id <> OLD.price_list_id OR NEW.amount_minor <> OLD.amount_minor
    OR NEW.effective_from <> OLD.effective_from OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A price is never edited' USING ERRCODE = '42501';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'A withdrawn price is not changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL THEN
    SELECT (now() AT TIME ZONE timezone)::date INTO today FROM tenants WHERE id = OLD.tenant_id;
    -- A price that is or was in force is history.
    IF today IS NULL OR OLD.effective_from <= today THEN
      RAISE EXCEPTION 'A price that is or was in force is not withdrawn' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_prices_guard_update BEFORE UPDATE ON service_prices
  FOR EACH ROW EXECUTE FUNCTION service_prices_guard_update();
