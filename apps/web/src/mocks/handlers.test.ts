import { fetchSession } from '@/app/session/api';
import { api, apiFetch, configureApi } from '@/shared/api';
import { signIn, signOut, TENANT_IDS, USER_IDS } from './db';

const POLICY_URL = 'http://localhost:3000/api/session/policy';

const permissionsOf = (policy: { permissions: { permission: string }[] } | null | undefined) =>
  policy?.permissions.map((grant) => grant.permission) ?? [];

describe('mock backend', () => {
  describe('GET /session', () => {
    it('starts signed in as the single-hospital admin', async () => {
      const session = await fetchSession();
      expect(session?.user.memberships).toEqual([
        { tenantId: TENANT_IDS.hospital, tenantName: 'Sample Hospital', roleId: 'admin' },
      ]);
      expect(session?.activeTenant?.id).toBe(TENANT_IDS.hospital);
      expect(session?.policy).toMatchObject({ tenantId: TENANT_IDS.hospital, roleId: 'admin' });
    });

    it('returns 401 when signed out', async () => {
      signOut();
      await expect(fetchSession()).resolves.toBeNull();
    });

    it('gives a user with two hospitals no active tenant until one is picked', async () => {
      signIn(USER_IDS.doctor);
      const session = await fetchSession();
      expect(session?.user.memberships.map((m) => m.tenantName)).toEqual([
        'Sample Hospital',
        'Riverside Clinic',
      ]);
      expect(session?.activeTenant).toBeNull();
      expect(session?.policy).toBeNull();
    });
  });

  describe('POST /session/switch-tenant', () => {
    it('rebinds the session and returns that hospital’s config and policy', async () => {
      signIn(USER_IDS.doctor);
      const hospital = await api.POST('/session/switch-tenant', {
        body: { tenantId: TENANT_IDS.hospital },
      });
      const clinic = await api.POST('/session/switch-tenant', {
        body: { tenantId: TENANT_IDS.clinic },
      });

      expect(hospital.data?.activeTenant).toMatchObject({
        name: 'Sample Hospital',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
      });
      expect(clinic.data?.activeTenant).toMatchObject({
        name: 'Riverside Clinic',
        locale: 'en-GB',
        timezone: 'Asia/Dubai',
        currency: 'AED',
      });
      // Different modules are enabled in each hospital.
      expect(hospital.data?.activeTenant?.features.laboratory).toBe(true);
      expect(clinic.data?.activeTenant?.features.laboratory).toBe(false);
      expect(clinic.data?.policy?.features).toEqual(clinic.data?.activeTenant?.features);
      // The same role carries different permissions in each hospital.
      expect(permissionsOf(hospital.data?.policy)).toContain('order:create');
      expect(permissionsOf(clinic.data?.policy)).not.toContain('order:create');
      expect(clinic.data?.policy?.tenantId).toBe(TENANT_IDS.clinic);

      // The switch is held by the session, so a later GET /session sees it.
      await expect(fetchSession()).resolves.toMatchObject({
        activeTenant: { id: TENANT_IDS.clinic },
      });
    });

    it('refuses a hospital the user does not belong to and keeps the current one', async () => {
      await expect(
        api.POST('/session/switch-tenant', { body: { tenantId: TENANT_IDS.clinic } }),
      ).rejects.toMatchObject({ code: 'forbidden', serverCode: 'not_a_member' });
      await expect(fetchSession()).resolves.toMatchObject({
        activeTenant: { id: TENANT_IDS.hospital },
      });
    });

    it('returns 401 when signed out', async () => {
      signOut();
      await expect(
        api.POST('/session/switch-tenant', { body: { tenantId: TENANT_IDS.hospital } }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('GET /session/policy', () => {
    it('returns the policy of the active tenant with an ETag, then 304 when unchanged', async () => {
      const first = await api.GET('/session/policy');
      expect(first.data).toMatchObject({ tenantId: TENANT_IDS.hospital, roleId: 'admin' });
      const etag = first.response.headers.get('ETag');
      expect(etag).toBeTruthy();

      const second = await apiFetch(POLICY_URL, { headers: { 'If-None-Match': etag ?? '' } });
      expect(second.status).toBe(304);
    });

    it('gives a custom role only its own permissions', async () => {
      signIn(USER_IDS.billingClerk);
      const { data } = await api.GET('/session/policy');
      expect(data?.roleId).toBe('billing_clerk');
      expect(permissionsOf(data)).toEqual(['patient:read', 'billing:read', 'billing:create']);
    });

    it('rejects a tenant header that does not match the session tenant', async () => {
      configureApi({ getTenantId: () => TENANT_IDS.clinic });
      await expect(api.GET('/session/policy')).rejects.toMatchObject({
        code: 'conflict',
        serverCode: 'tenant_mismatch',
      });
    });

    it('returns 401 when signed out', async () => {
      signOut();
      await expect(api.GET('/session/policy')).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });
});
