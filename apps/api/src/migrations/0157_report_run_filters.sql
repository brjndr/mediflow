-- A stored report may carry filters (#1100): the audit log export keeps the person, record type,
-- record id and action it was asked for, so the job applies the same ones as the search.
ALTER TABLE report_runs ADD COLUMN filters jsonb;
