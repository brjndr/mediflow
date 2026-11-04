-- Two more operational reports (#124): activity by doctor and pharmacy sales. Additive: the same
-- check, with the new kinds allowed.
ALTER TABLE report_runs DROP CONSTRAINT report_runs_kind_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check CHECK (
  kind IN ('opd_census', 'revenue', 'doctor_activity', 'lab_turnaround', 'pharmacy_sales', 'stock')
);
