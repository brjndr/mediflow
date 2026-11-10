import { Siren } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The emergency department's front door (ER-01, #171): quick registration, including an
 * unidentified patient with a temporary ID, triage categories with waiting-time targets, and the
 * live board. Until the API has it (BE-26, #175) the screen runs on the mock; the endpoints are
 * in the planned contract. It refers to patients by id only.
 */
export const emergencyFeature: FeatureManifest = {
  id: 'emergency',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Emergency', care: 'Emergency care' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'emergency',
  routes: [
    {
      path: 'emergency',
      lazy: () => import('./routes/EmergencyBoard'),
      requires: ['emergency:read'],
    },
    // One patient's care and how they leave (ER-02, #172).
    {
      path: 'emergency/:caseId',
      titleKey: 'care',
      lazy: () => import('./routes/CaseCare'),
      requires: ['emergency:read'],
    },
  ],
  nav: { icon: Siren, order: 26, requires: ['emergency:read'] },
  permissions: [
    'emergency:read',
    'emergency:register',
    'emergency:triage',
    'emergency:care',
    'emergency:dispose',
  ],
};
