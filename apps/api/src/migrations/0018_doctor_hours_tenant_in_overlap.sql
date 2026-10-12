-- The rule against overlapping sessions (0017) compared a doctor's id and nothing of the
-- hospital. Constraints are checked without row-level security, and this one before the foreign
-- key that carries the hospital, so SQL under one hospital's role could have told, from which
-- error an insert drew, when another hospital's doctor works. No API route can do that (a doctor
-- is always found through row-level security first), and nothing was stored or blocked, but the
-- rule should not be able to see across hospitals at all. With the hospital in it, it cannot.
ALTER TABLE doctor_hours DROP CONSTRAINT doctor_hours_no_overlap;
ALTER TABLE doctor_hours ADD CONSTRAINT doctor_hours_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  doctor_id WITH =,
  day WITH =,
  int4range(start_minute, end_minute) WITH &&
);
