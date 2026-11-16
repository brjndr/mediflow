-- Hospital settings for admissions (#952). One row per hospital, absent until first saved:
-- every setting then has its default.
--
-- * `require_discharge_summary`: when on, a discharge is refused (409 `summary_unsigned`) until
--   the stay's discharge summary is signed. Off by default, so nothing changes for a hospital
--   that leaves it.
CREATE TABLE admission_settings (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants (id),
  require_discharge_summary boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('admission_settings', 'SELECT, INSERT, UPDATE');
