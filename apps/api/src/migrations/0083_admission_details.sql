-- What is recorded when a patient is admitted (#575): the doctor's advice, the attendant who
-- stays with the patient, the deposit the desk asked for and the consents the patient gave.
-- All optional and never changed after the admission is made (the guard trigger of 0078 refuses
-- a change to any column it does not list). The deposit is a record of the amount, not a
-- payment: money is taken through billing.
ALTER TABLE admissions
  ADD COLUMN advice_note text CHECK (advice_note IS NULL OR char_length(advice_note) BETWEEN 1 AND 1000),
  ADD COLUMN attendant_name text CHECK (attendant_name IS NULL OR char_length(attendant_name) BETWEEN 1 AND 100),
  ADD COLUMN attendant_relation text CHECK (
    attendant_relation IS NULL OR attendant_relation IN
      ('spouse', 'parent', 'child', 'sibling', 'relative', 'friend', 'other')
  ),
  ADD COLUMN attendant_phone text CHECK (attendant_phone IS NULL OR char_length(attendant_phone) BETWEEN 5 AND 20),
  ADD COLUMN deposit_minor bigint CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  ADD COLUMN consents text[] NOT NULL DEFAULT '{}' CHECK (
    consents <@ ARRAY['admission', 'treatment', 'financial', 'privacy']::text[]
  ),
  ADD CONSTRAINT admissions_attendant_needs_name CHECK (
    (attendant_relation IS NULL AND attendant_phone IS NULL) OR attendant_name IS NOT NULL
  );
