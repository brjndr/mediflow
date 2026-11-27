-- Who is told that an offboarding hospital's data will be deleted (#1210): whoever manages the
-- hospital, not whoever holds the role id `admin`. A hospital can leave that role empty while a
-- custom role manages it. Managing means a role holding `role:manage` or `staff:manage`, the two
-- the API never lets a hospital lose. Same signature as in 0142, so its grants stay.
CREATE OR REPLACE FUNCTION offboarding_admin_contacts(hospital uuid) RETURNS TABLE (user_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.email
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = hospital AND t.status = 'offboarding'
      AND m.status = 'active' AND u.status = 'active'
      AND NOT u.is_platform_admin
      AND EXISTS (
        SELECT FROM role_permissions p
        WHERE p.tenant_id = m.tenant_id AND p.role_id = m.role_id
          AND p.permission IN ('role:manage', 'staff:manage'))
  $$;
