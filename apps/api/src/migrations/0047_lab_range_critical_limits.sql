-- A critical limit lies strictly beyond the normal limit on its own side (#310): a critical low
-- needs a low and is below it, a critical high needs a high and is above it. With low < high this
-- also puts a critical low below a critical high, so no result is both normal and critical.
-- The rows already saved are checked too: none is in a hosted database yet.
ALTER TABLE lab_test_ranges
  DROP CONSTRAINT lab_test_ranges_critical_low,
  DROP CONSTRAINT lab_test_ranges_critical_high,
  ADD CONSTRAINT lab_test_ranges_critical_low CHECK (
    critical_low IS NULL OR (low IS NOT NULL AND critical_low < low)
  ),
  ADD CONSTRAINT lab_test_ranges_critical_high CHECK (
    critical_high IS NULL OR (high IS NOT NULL AND critical_high > high)
  );
