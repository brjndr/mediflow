-- Vital sign ranges by age band, kept as they were (#378, #379).
--
-- Until now a hospital had one row per measure, for adults, which nothing could change. A range is
-- now one row of a band (infant, child, adolescent, adult) and a measure that starts to apply at
-- `effective_from`; a change is new rows, never an update, so a reading is marked against the
-- ranges in effect when it was recorded. A row with no limits says that the measure is not
-- checked for that band from then on.

ALTER TABLE vital_ranges DROP CONSTRAINT vital_ranges_pkey;
ALTER TABLE vital_ranges DROP CONSTRAINT vital_ranges_limits;

ALTER TABLE vital_ranges
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN band text NOT NULL DEFAULT 'adult'
    CONSTRAINT vital_ranges_band CHECK (band IN ('infant', 'child', 'adolescent', 'adult')),
  -- The rows that existed apply to every reading before the first edit, as they always did.
  ADD COLUMN effective_from timestamptz NOT NULL DEFAULT 'epoch',
  ADD COLUMN created_by uuid REFERENCES users (id);

ALTER TABLE vital_ranges
  ADD PRIMARY KEY (id),
  ADD CONSTRAINT vital_ranges_limits CHECK (low IS NULL OR high IS NULL OR low < high),
  ADD CONSTRAINT vital_ranges_version UNIQUE (tenant_id, band, measure, effective_from);

-- Rows written from now on name their band and their time.
ALTER TABLE vital_ranges ALTER COLUMN band DROP DEFAULT;
ALTER TABLE vital_ranges ALTER COLUMN effective_from DROP DEFAULT;

-- A hospital that had some rows checked only those measures: keep that for adults.
INSERT INTO vital_ranges (tenant_id, band, measure, effective_from)
SELECT t.tenant_id, 'adult', m.measure, 'epoch'
FROM (SELECT DISTINCT tenant_id FROM vital_ranges) t
CROSS JOIN (VALUES ('systolic'), ('diastolic'), ('pulse'), ('temperature'), ('spo2')) m (measure)
WHERE NOT EXISTS (
  SELECT 1 FROM vital_ranges r WHERE r.tenant_id = t.tenant_id AND r.measure = m.measure
);

-- Append-only for the app: it reads and adds rows.
GRANT INSERT ON vital_ranges TO mediflow_app;
