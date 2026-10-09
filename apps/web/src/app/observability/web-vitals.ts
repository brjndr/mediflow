import type { Metric } from 'web-vitals';

/**
 * One Core Web Vital measurement, ready to send. It carries the route pattern and the tenant id
 * and nothing else about the page: no URL, no ids from the address, no element text. Those could
 * identify a patient, and none of them is needed to see which screen is slow for which hospital.
 */
export interface VitalReport {
  name: 'LCP' | 'INP' | 'CLS';
  value: number;
  rating: Metric['rating'];
  /** The route as declared, e.g. `/patients/:patientId`. Never the address with real ids. */
  route: string;
  tenantId: string | undefined;
}

export type VitalsSink = (report: VitalReport) => void;

interface RouteMatch {
  route: { path?: string };
}

/**
 * The declared pattern of the matched route, built from the route definitions and not from the
 * address: `/patients/:patientId`, `/` for the home route, `/*` for an unknown address.
 */
export function routePattern(matches: readonly RouteMatch[]): string {
  const segments = matches
    .map((match) => match.route.path ?? '')
    .flatMap((path) => path.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}`;
}

interface VitalsContext {
  getRoute: () => string;
  getTenantId: () => string | undefined;
  sink: VitalsSink;
}

const REPORTED = new Set(['LCP', 'INP', 'CLS']);

/** Reduces a web-vitals metric to the fields above. Attribution data is deliberately dropped. */
export function toVitalReport(metric: Metric, context: VitalsContext): VitalReport | undefined {
  if (!REPORTED.has(metric.name)) return undefined;
  return {
    name: metric.name as VitalReport['name'],
    value: metric.value,
    rating: metric.rating,
    route: context.getRoute(),
    tenantId: context.getTenantId(),
  };
}

/**
 * Starts measuring LCP, INP and CLS. Call it after first paint (see main.tsx): the web-vitals
 * library is imported here on demand so it is never part of the initial bundle.
 */
export async function startWebVitals(context: VitalsContext): Promise<void> {
  const { onCLS, onINP, onLCP } = await import('web-vitals');
  const report = (metric: Metric) => {
    const vital = toVitalReport(metric, context);
    if (vital) context.sink(vital);
  };
  onLCP(report);
  onINP(report);
  onCLS(report);
}

/**
 * Where measurements go. Nothing receives them yet: the observability backend (Sentry and
 * OpenTelemetry, see CLAUDE.md) arrives with F-12 and the hardening milestone, and replaces this
 * with a sender. Until then measurements are taken and dropped.
 */
export const discardVitals: VitalsSink = () => {};
