import { ShieldPlus } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Insurer, TPA and corporate masters (IN-01, #181): the organisations a hospital bills instead
 * of the patient, with their plans (what is covered, the patient's share, limits and eligibility
 * rules) and effective-dated rate agreements. The policy capture, pre-authorization, split
 * billing and claims of the insurance milestone (M21) build on these records by id. No patient
 * data is held here. Until the API has them the screens run on the mock (the endpoints are in
 * the planned contract).
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const insuranceFeature: FeatureManifest = {
  id: 'insurance',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Insurers and TPAs',
        create: 'Add an insurer, TPA or corporate',
        record: 'Insurer, TPA or corporate',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'insurance',
  routes: [
    { path: 'insurance', lazy: () => import('./routes/PayerList'), requires: ['payer:read'] },
    {
      path: 'insurance/new',
      titleKey: 'create',
      lazy: () => import('./routes/PayerCreate'),
      requires: ['payer:manage'],
    },
    {
      path: 'insurance/:payerId',
      titleKey: 'record',
      lazy: () => import('./routes/PayerDetail'),
      requires: ['payer:read'],
    },
  ],
  nav: { icon: ShieldPlus, order: 86, requires: ['payer:read'] },
  permissions: ['payer:read', 'payer:manage'],
};
