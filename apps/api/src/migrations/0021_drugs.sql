-- Drugs and consumables (BE-17b): what each medicine and consumable a hospital keeps is.
-- Reference data: no patient data, no price and no stock (those go with the batch, in the
-- pharmacy). A dispense, a stock entry and a prescription line will store the name, form,
-- strength, schedule and controlled flag as they were when the line was written, so renaming or
-- reclassifying an item here never changes history.

CREATE TABLE drugs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  type text NOT NULL CHECK (type IN ('medicine', 'consumable')),
  -- The generic name of a medicine, or what a consumable is.
  generic_name text NOT NULL
    CHECK (generic_name = btrim(generic_name) AND length(generic_name) BETWEEN 1 AND 150),
  -- Optional text is absent, never empty.
  brand_name text
    CHECK (brand_name IS NULL
      OR (brand_name = btrim(brand_name) AND length(brand_name) BETWEEN 1 AND 150)),
  form text NOT NULL CHECK (form IN (
    'tablet', 'capsule', 'syrup', 'suspension', 'injection', 'infusion', 'cream', 'ointment',
    'drops', 'inhaler', 'powder', 'device', 'other'
  )),
  -- As written on the pack: "500 mg".
  strength text
    CHECK (strength IS NULL OR (strength = btrim(strength) AND length(strength) BETWEEN 1 AND 30)),
  -- What one unit of stock is: "strip of 10", "piece".
  unit text CHECK (unit IS NULL OR (unit = btrim(unit) AND length(unit) BETWEEN 1 AND 30)),
  -- The drug schedule, recorded as a class. What each requires is the pharmacy module's to enforce.
  schedule text NOT NULL CHECK (schedule IN ('none', 'h', 'h1', 'x', 'g', 'narcotic')),
  controlled boolean NOT NULL DEFAULT false,
  tax_class text NOT NULL CHECK (tax_class IN ('exempt', 'reduced', 'standard', 'higher')),
  -- Stock at or below this many units is low. Empty: no level set.
  reorder_level integer CHECK (reorder_level IS NULL OR reorder_level BETWEEN 0 AND 1000000),
  -- Archived, never deleted: it stays on the stock and prescriptions that name it.
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Stored, so uniqueness, ordering and search are plain comparisons on a column: a function in
  -- the comparison could not use an index under row-level security.
  generic_lower text GENERATED ALWAYS AS (lower(generic_name)) STORED,
  brand_lower text GENERATED ALWAYS AS (lower(coalesce(brand_name, ''))) STORED,
  strength_lower text GENERATED ALWAYS AS (lower(coalesce(strength, ''))) STORED,
  search_text text
    GENERATED ALWAYS AS (lower(generic_name) || ' ' || lower(coalesce(brand_name, ''))) STORED,
  -- Schedule X and narcotic items are controlled, whatever the code sends.
  CONSTRAINT drugs_controlled_schedules CHECK (schedule NOT IN ('x', 'narcotic') OR controlled),
  -- One item of a generic name, brand, form and strength per hospital, whatever the capitals,
  -- archived or not.
  CONSTRAINT drugs_exists UNIQUE (tenant_id, generic_lower, brand_lower, form, strength_lower),
  -- So another table refers to an item together with its hospital (see departments, 0014).
  CONSTRAINT drugs_tenant_id_id UNIQUE (tenant_id, id)
);

-- The list: a hospital's active (or archived) items by generic name, then brand.
CREATE INDEX drugs_tenant_list ON drugs (tenant_id, archived, generic_lower, brand_lower, id);

-- No DELETE for the app role.
SELECT enable_tenant_rls('drugs', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION drugs_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An item''s hospital and identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  -- Whatever the statement set it to: the version is the database's to count.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drugs_guard_update BEFORE UPDATE ON drugs
  FOR EACH ROW EXECUTE FUNCTION drugs_guard_update();
