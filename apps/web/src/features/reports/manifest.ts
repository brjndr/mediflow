import { BarChart3 } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Reports (#121): the hospital's operational reports worked out on the spot for a few days, or
 * made by a job and kept with a CSV file for up to a year (asked about with backing off, then
 * downloaded by a signed link). The reports hold counts, money and catalog names, never a patient.
 *
 * A desktop-only screen (CLAUDE.md, Responsive Design): reports and analytics.
 */
export const reportsFeature: FeatureManifest = {
  id: 'reports',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Reports' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'reports',
  routes: [
    { path: 'reports', lazy: () => import('./routes/ReportsPage'), requires: ['report:read'] },
  ],
  nav: { icon: BarChart3, order: 700, requires: ['report:read'] },
  permissions: ['report:read', 'report:export', 'invoice:read'],
  dashboardWidgets: [
    {
      id: 'flow',
      component: () => import('./components/PatientFlowWidget'),
      requires: ['report:read'],
      size: 'lg',
    },
    {
      id: 'visits',
      component: () => import('./components/VisitsTodayWidget'),
      requires: ['report:read'],
      size: 'md',
    },
    {
      id: 'unpaid',
      component: () => import('./components/UnpaidInvoicesWidget'),
      requires: ['report:read', 'invoice:read'],
      size: 'md',
    },
  ],
};
