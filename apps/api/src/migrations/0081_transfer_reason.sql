-- Why a patient was given this bed (a transfer or a bed given later), from a list, and an
-- optional plain-text note. Both stay empty for the bed given at admission.
ALTER TABLE bed_assignments
  ADD COLUMN move_reason text CHECK (
    move_reason IN ('clinical', 'step_down', 'isolation', 'patient_request', 'ward_closure', 'other')
  ),
  ADD COLUMN move_note text CHECK (move_note IS NULL OR char_length(move_note) <= 200),
  ADD CONSTRAINT bed_assignments_note_needs_reason CHECK (move_note IS NULL OR move_reason IS NOT NULL);
