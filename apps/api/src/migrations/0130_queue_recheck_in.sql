-- Checking an appointment in again after its token was cancelled (Q-06, #491).
--
-- An appointment still gives one token that counts: the unique index now leaves cancelled tokens
-- out, so a new check-in can issue another token for the appointment. The cancelled token keeps
-- its appointment_id as the record. The index is remade under the same name, as the API reads
-- its violation as `already_checked_in`.
DROP INDEX queue_tokens_one_per_appointment;
CREATE UNIQUE INDEX queue_tokens_one_per_appointment ON queue_tokens (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'cancelled';
