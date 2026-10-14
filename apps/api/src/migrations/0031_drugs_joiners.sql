-- An item is compared with the hospital's others with the joiners Indic scripts need (U+200C
-- and U+200D) left out (#322). They are allowed in a name, and kept in it as typed, but many
-- places print them as nothing, so a name with a joiner and the same without one read alike: two
-- such names were two items, and the second sidestepped the duplicate check and the
-- `beside_controlled` trace.
--
-- Stored, as the lower-case columns are (0021): a function in the comparison could not use an
-- index under row-level security. `chr` and `translate` are immutable, so they may make a
-- generated column.
ALTER TABLE drugs
  ADD COLUMN generic_key text
    GENERATED ALWAYS AS (lower(translate(generic_name, chr(8204) || chr(8205), ''))) STORED,
  ADD COLUMN brand_key text
    GENERATED ALWAYS AS (lower(translate(coalesce(brand_name, ''), chr(8204) || chr(8205), '')))
    STORED,
  ADD COLUMN strength_key text
    GENERATED ALWAYS AS (lower(translate(coalesce(strength, ''), chr(8204) || chr(8205), '')))
    STORED;

-- The same item once per hospital, joiners or not. `drugs_exists` stays: whatever it allows, this
-- allows less.
CREATE UNIQUE INDEX drugs_same ON drugs (tenant_id, generic_key, brand_key, form, strength_key);

-- The items of a generic name in a form: the duplicate check and the controlled sibling.
CREATE INDEX drugs_tenant_generic ON drugs (tenant_id, generic_key, form);
