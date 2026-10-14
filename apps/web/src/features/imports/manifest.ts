import { FileUp } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The import centre: many services, drugs, lab tests or patients loaded at once from a CSV file.
 * The file is read in the browser and its columns matched to the fields of the kind; the rows are
 * checked by the server before anything is written, and a batch is written whole or not at all.
 * Loading a kind also needs that kind's own permission, so the centre lets nobody add what they
 * could not add one at a time.
 *
 * The bulk import centre: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const importsFeature: FeatureManifest = {
  id: 'imports',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Import centre' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'imports',
  routes: [
    { path: 'imports', lazy: () => import('./routes/ImportList'), requires: ['import:read'] },
    { path: 'imports/new', lazy: () => import('./routes/ImportNew'), requires: ['import:run'] },
    {
      path: 'imports/:batchId',
      lazy: () => import('./routes/ImportDetail'),
      requires: ['import:read'],
    },
  ],
  nav: { icon: FileUp, order: 790, requires: ['import:read'] },
  permissions: ['import:read', 'import:run'],
};
