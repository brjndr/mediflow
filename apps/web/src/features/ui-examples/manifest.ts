import type { FeatureManifest } from '@/registry';

/**
 * Example pages for the shared building blocks (data grid, charts, form kit, rich text). They
 * show how each block is meant to be used and give a place to try one out with synthetic data.
 *
 * Off by default like every feature. It is switched on for the sample hospital in the mock
 * backend, and has no navigation entry: open /examples.
 */
export const uiExamplesFeature: FeatureManifest = {
  id: 'ui_examples',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'UI examples' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  featureFlag: 'ui_examples',
  routes: [
    { path: 'examples', lazy: () => import('./routes/ExamplesIndex'), requires: [] },
    { path: 'examples/grid', lazy: () => import('./routes/GridExample'), requires: [] },
    { path: 'examples/charts', lazy: () => import('./routes/ChartsExample'), requires: [] },
    { path: 'examples/form', lazy: () => import('./routes/FormExample'), requires: [] },
    { path: 'examples/editor', lazy: () => import('./routes/EditorExample'), requires: [] },
  ],
  permissions: [],
};
