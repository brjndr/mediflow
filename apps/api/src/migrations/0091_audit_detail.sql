-- A short code or id that says more about an audit entry than the record it names, e.g. the
-- revision of a medico-legal record that was printed. Never a field value. Nullable and additive.
ALTER TABLE audit_log ADD COLUMN detail text CHECK (detail IS NULL OR length(detail) <= 127);
