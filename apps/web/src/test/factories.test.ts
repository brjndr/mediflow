import { buildPatient, buildTenant, resetFactories } from './factories';

describe('factories', () => {
  beforeEach(() => resetFactories());

  it('builds deterministic synthetic records', () => {
    expect(buildTenant().id).toBe('tenant_1');
    const patient = buildPatient({ tenantId: 'tenant_9' });
    expect(patient.mrn).toBe('MRN-TEST-00002');
    expect(patient.tenantId).toBe('tenant_9');
  });
});
