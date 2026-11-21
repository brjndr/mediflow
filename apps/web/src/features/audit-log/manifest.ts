import { ScrollText } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The hospital's own audit log (#1066): a searchable list of who did what to which record, and an
 * export of a range of days (the `audit_log` report, a stored run with a CSV). Entries name
 * record ids, never a patient. Phone and tablet as well as desktop.
 */
export const auditLogFeature: FeatureManifest = {
  id: 'audit_log',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Audit log' }, hi: { title: 'ऑडिट लॉग' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'audit_log',
  routes: [
    {
      path: 'audit-log',
      lazy: () => import('./routes/AuditLogPage'),
      requires: ['auditLog:read'],
    },
  ],
  nav: { icon: ScrollText, order: 950, requires: ['auditLog:read'] },
  permissions: ['auditLog:read', 'auditLog:export'],
};
