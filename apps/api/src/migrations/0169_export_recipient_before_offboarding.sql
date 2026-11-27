-- Whether anybody at a hospital could receive its offboarding export, asked before the offboarding
-- starts so the platform can be warned (#1234). `offboarding_admin_contacts` answers only for a
-- hospital that is already offboarding, and the platform role has no grant on users, so one yes or
-- no is answered here: no id and no address. The conditions are those of the export link: an active
-- member with an active account that is not a platform admin, whose role holds both `role:manage`
-- and `patient:read` at scope `all`.
CREATE FUNCTION has_export_recipient(hospital uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = hospital AND m.status = 'active' AND u.status = 'active'
        AND NOT u.is_platform_admin
        AND (SELECT count(*) FROM role_permissions p
             WHERE p.tenant_id = m.tenant_id AND p.role_id = m.role_id AND p.scope = 'all'
               AND p.permission IN ('role:manage', 'patient:read')) = 2
    )
  $$;
REVOKE ALL ON FUNCTION has_export_recipient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_export_recipient(uuid) TO mediflow_platform;
