/**
 * Synthetic data factories. Never use real patient data in tests, fixtures or screenshots.
 * Deterministic sequences keep snapshots and assertions stable.
 */
let seq = 0;
const next = () => ++seq;

export interface TenantFixture {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  locale: string;
}

export function buildTenant(overrides: Partial<TenantFixture> = {}): TenantFixture {
  const n = next();
  return {
    id: `tenant_${n}`,
    name: `Sample Hospital ${n}`,
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
    ...overrides,
  };
}

export interface PatientFixture {
  id: string;
  tenantId: string;
  mrn: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
}

export function buildPatient(overrides: Partial<PatientFixture> = {}): PatientFixture {
  const n = next();
  return {
    id: `pat_${n}`,
    tenantId: 'tenant_1',
    mrn: `MRN-TEST-${String(n).padStart(5, '0')}`,
    givenName: `Test${n}`,
    familyName: 'Patient',
    dateOfBirth: '1990-01-01',
    ...overrides,
  };
}

export function resetFactories() {
  seq = 0;
}
