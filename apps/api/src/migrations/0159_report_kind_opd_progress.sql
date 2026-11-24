-- OPD progress by day for the home page (#1124): the same check, with the new kind allowed.
ALTER TABLE report_runs DROP CONSTRAINT report_runs_kind_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check CHECK (
  kind IN (
    'opd_census', 'revenue', 'doctor_activity', 'lab_turnaround', 'pharmacy_sales', 'stock',
    'collections', 'collections_by_close', 'outstanding', 'opd_hourly', 'audit_log', 'opd_progress'
  )
);
