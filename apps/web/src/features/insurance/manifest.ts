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
        claims: 'Insurance claims',
        claimAging: 'Aging of unpaid claims',
        claim: 'Insurance claim',
        credit: 'Corporate credit',
        creditAccount: 'Credit account',
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
      path: 'claims',
      titleKey: 'claims',
      lazy: () => import('./routes/ClaimList'),
      requires: ['claim:read'],
    },
    {
      path: 'claims/aging',
      titleKey: 'claimAging',
      lazy: () => import('./routes/ClaimAging'),
      requires: ['claim:read'],
    },
    {
      path: 'claims/:claimId',
      titleKey: 'claim',
      lazy: () => import('./routes/ClaimDetail'),
      requires: ['claim:read'],
    },
    {
      path: 'credit',
      titleKey: 'credit',
      lazy: () => import('./routes/CreditAccountList'),
      requires: ['receivable:read'],
    },
    {
      path: 'credit/:payerId',
      titleKey: 'creditAccount',
      lazy: () => import('./routes/CreditAccountDetail'),
      requires: ['receivable:read'],
    },
    {
      path: 'insurance/:payerId',
      titleKey: 'record',
      lazy: () => import('./routes/PayerDetail'),
      requires: ['payer:read'],
    },
  ],
  nav: { icon: ShieldPlus, order: 86, requires: ['payer:read'] },
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/InsuranceTab'),
      requires: ['policy:read'],
      order: 45,
    },
    {
      slot: 'invoice.builder.panels',
      component: () => import('./components/LimitPanel'),
      requires: ['preauth:read'],
    },
    {
      slot: 'invoice.builder.panels',
      component: () => import('./components/SplitPanel'),
      requires: ['policy:read'],
      order: 10,
    },
    {
      slot: 'invoice.builder.panels',
      component: () => import('./components/CreditBillPanel'),
      requires: ['receivable:manage'],
      order: 20,
    },
  ],
  permissions: [
    'payer:read',
    'payer:manage',
    'policy:read',
    'policy:manage',
    'preauth:read',
    'preauth:manage',
    'claim:read',
    'claim:manage',
    'claim:writeoff',
    'receivable:read',
    'receivable:manage',
    'receivable:receipt',
  ],
};
