import { BookOpen } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Diagnosis (ICD-10) and procedure codes: the code sets, searched on the server and never
 * bundled, and the hospital's favourites among them. The screen is where a manager looks codes
 * up and marks favourites; `CodeSearch`, exported from this feature, is the search box the
 * clinical screens record a code with.
 *
 * Master data: the screen is desktop-only (CLAUDE.md, Responsive Design). The search box works
 * at every width.
 */
export const codesFeature: FeatureManifest = {
  id: 'codes',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Diagnosis and procedure codes' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'codes',
  routes: [{ path: 'codes', lazy: () => import('./routes/CodeList'), requires: ['code:read'] }],
  nav: { icon: BookOpen, order: 90, requires: ['code:read'] },
  permissions: ['code:read', 'code:manage'],
};
