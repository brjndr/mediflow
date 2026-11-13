-- #818: `discharge:clear` was split into `discharge:clearNursing`, `discharge:clearPharmacy` and
-- `discharge:clearLab` (#802). A custom role that held the old permission gets the three new ones
-- with the same scope, so it can still clear every kind. Built-in roles are left to their defaults.
-- Additive and idempotent: an existing grant is kept as it is.
INSERT INTO role_permissions (tenant_id, role_id, permission, scope)
SELECT rp.tenant_id, rp.role_id, kind.permission, rp.scope
FROM role_permissions rp
JOIN roles r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
CROSS JOIN (VALUES
  ('discharge:clearNursing'), ('discharge:clearPharmacy'), ('discharge:clearLab')
) AS kind (permission)
WHERE rp.permission = 'discharge:clear' AND NOT r.built_in
ON CONFLICT (tenant_id, role_id, permission) DO NOTHING;
