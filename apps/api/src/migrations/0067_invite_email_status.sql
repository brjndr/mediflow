-- When an invitation's email was queued, sent, or last failed (#349). Times only: never the
-- address or the error, which the job log leaves out too. All three are null for an invitation
-- from before this migration, and for one whose email has not been queued yet.
ALTER TABLE invites
  ADD COLUMN email_queued_at timestamptz,
  ADD COLUMN email_sent_at timestamptz,
  ADD COLUMN email_failed_at timestamptz;
