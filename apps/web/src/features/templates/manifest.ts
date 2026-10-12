import { FileText } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Document templates: the texts a hospital starts a prescription, a clinical note, a consent
 * form or a discharge summary from, each its own and each kept in versions that are never
 * changed. A template is a blank form with placeholders; the clinical modules fill them in when
 * a document is made, and record the version they used.
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const templatesFeature: FeatureManifest = {
  id: 'templates',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Document templates' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'templates',
  routes: [
    {
      path: 'templates',
      lazy: () => import('./routes/TemplateList'),
      requires: ['template:read'],
    },
    {
      path: 'templates/new',
      lazy: () => import('./routes/TemplateCreate'),
      requires: ['template:manage'],
    },
    {
      path: 'templates/:templateId',
      lazy: () => import('./routes/TemplateDetail'),
      requires: ['template:read'],
    },
  ],
  nav: { icon: FileText, order: 100, requires: ['template:read'] },
  permissions: ['template:read', 'template:manage'],
};
