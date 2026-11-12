-- A hospital's admin edits its letterhead details (#696): address, phone, registration number
-- and GSTIN. Until now only the platform role could change a hospital's row.
--
-- The app role gets UPDATE on those columns alone (plus the version and timestamp), and only on
-- its own hospital's row. Name, locale, status, limits and the rest stay with the platform.
CREATE POLICY tenant_profile_update ON tenants FOR UPDATE TO mediflow_app
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
GRANT UPDATE (address, phone, registration_number, gstin, version, updated_at)
  ON tenants TO mediflow_app;
