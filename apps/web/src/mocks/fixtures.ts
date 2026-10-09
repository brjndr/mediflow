import type { components } from '@mediflow/contract';

type SessionDto = components['schemas']['Session'];

/** Synthetic data only. F-04 replaces this with two hospitals, several users and roles. */
export const sampleSession: SessionDto = {
  user: {
    id: 'user_1',
    email: 'admin@sample-hospital.test',
    name: 'Sample Admin',
    memberships: [{ tenantId: 'tenant_1', tenantName: 'Sample Hospital', roleId: 'admin' }],
  },
  activeTenant: {
    id: 'tenant_1',
    slug: 'sample-hospital',
    name: 'Sample Hospital',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    theme: { primary: 'oklch(0.52 0.1 180)' },
    features: {},
    auth: { mode: 'password' },
  },
  policy: {
    tenantId: 'tenant_1',
    roleId: 'admin',
    permissions: [],
    features: {},
    version: '1',
  },
};
