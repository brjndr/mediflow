import { createMemoryRouter } from 'react-router-dom';
import type { Metric } from 'web-vitals';
import { routePattern, toVitalReport, type VitalReport } from './web-vitals';

const routes = [
  { path: '/login', element: null },
  {
    path: '/',
    element: null,
    children: [
      { index: true, element: null },
      { path: 'notices', element: null },
      { path: 'patients/:patientId', element: null },
      { path: 'patients/:patientId/encounters/:encounterId', element: null },
      { path: '*', element: null },
    ],
  },
];

const patternAt = (address: string) =>
  routePattern(createMemoryRouter(routes, { initialEntries: [address] }).state.matches);

/** A metric as the web-vitals library reports it, including data that must not be forwarded. */
const metric = (overrides: Partial<Metric>): Metric =>
  ({
    name: 'LCP',
    value: 1834.2,
    rating: 'good',
    delta: 1834.2,
    id: 'v5-1700000000000-1234567890123',
    navigationType: 'navigate',
    entries: [{ url: 'https://app.test/patients/pat_123', element: 'h1.patient-name' }],
    ...overrides,
  }) as unknown as Metric;

describe('routePattern', () => {
  it('is the declared route, never the address', () => {
    expect(patternAt('/')).toBe('/');
    expect(patternAt('/login')).toBe('/login');
    expect(patternAt('/notices')).toBe('/notices');
    expect(patternAt('/patients/pat_123')).toBe('/patients/:patientId');
    expect(patternAt('/patients/pat_123/encounters/enc_9?tab=notes')).toBe(
      '/patients/:patientId/encounters/:encounterId',
    );
  });

  it('reports an unknown address as the catch-all, not as what was typed', () => {
    expect(patternAt('/jane-doe-1984/records')).toBe('/*');
  });
});

describe('toVitalReport', () => {
  const context = {
    getRoute: () => '/patients/:patientId',
    getTenantId: () => 'tenant_1',
    sink: () => {},
  };

  it('keeps the metric, its rating, the route pattern and the tenant, and nothing else', () => {
    const report = toVitalReport(metric({}), context);
    expect(report).toEqual<VitalReport>({
      name: 'LCP',
      value: 1834.2,
      rating: 'good',
      route: '/patients/:patientId',
      tenantId: 'tenant_1',
    });
    // No address, record id or element from the page survives.
    expect(JSON.stringify(report)).not.toMatch(/pat_123|app\.test|patient-name/);
  });

  it('reads the route and tenant when the metric is reported, not when measuring started', () => {
    let route = '/';
    let tenantId: string | undefined = undefined;
    const live = { getRoute: () => route, getTenantId: () => tenantId, sink: () => {} };
    expect(toVitalReport(metric({ name: 'CLS', value: 0.02 }), live)).toMatchObject({
      route: '/',
      tenantId: undefined,
    });
    route = '/notices';
    tenantId = 'tenant_2';
    expect(toVitalReport(metric({ name: 'INP', value: 120 }), live)).toMatchObject({
      name: 'INP',
      route: '/notices',
      tenantId: 'tenant_2',
    });
  });

  it('ignores metrics that are not Core Web Vitals', () => {
    expect(toVitalReport(metric({ name: 'TTFB' }), context)).toBeUndefined();
    expect(toVitalReport(metric({ name: 'FCP' }), context)).toBeUndefined();
  });
});
