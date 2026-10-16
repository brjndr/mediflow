import { Pill } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The drug and consumable master: what each medicine and consumable the hospital keeps is (its
 * generic name and brand, form, strength, schedule, whether it is controlled). Prescriptions,
 * pharmacy and stores refer to these items by id. Stock, batches and selling prices are not
 * here: they belong to the pharmacy.
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const drugsFeature: FeatureManifest = {
  id: 'drugs',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Drugs and consumables',
        create: 'Add a drug or consumable',
        record: 'Drug or consumable',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'drugs',
  routes: [
    { path: 'drugs', lazy: () => import('./routes/DrugList'), requires: ['drug:read'] },
    {
      path: 'drugs/new',
      titleKey: 'create',
      lazy: () => import('./routes/DrugCreate'),
      requires: ['drug:manage'],
    },
    {
      path: 'drugs/:drugId',
      titleKey: 'record',
      lazy: () => import('./routes/DrugDetail'),
      requires: ['drug:read'],
    },
  ],
  nav: { icon: Pill, order: 60, requires: ['drug:read'] },
  permissions: ['drug:read', 'drug:manage'],
};
