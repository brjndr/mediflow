import type { FeatureManifest } from '@/registry';

/**
 * Billing (#109): the invoice builder. A visit's pending charges and lines typed in are saved as
 * a draft and issued. The charge ledger and invoices are the billing API's (#114); until it
 * exists the screens run on the mock. Reached from a consultation (`encounter.detail.actions`),
 * which is why there is no navigation entry yet: the invoice list comes with #110.
 */
export const billingFeature: FeatureManifest = {
  id: 'billing',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Billing',
        new: 'New invoice',
        detail: 'Invoice',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  featureFlag: 'billing',
  routes: [
    {
      path: 'billing/new',
      lazy: () => import('./routes/InvoiceNew'),
      requires: ['invoice:create', 'charge:read', 'encounter:read'],
      titleKey: 'new',
    },
    {
      path: 'billing/invoices/:invoiceId',
      lazy: () => import('./routes/InvoiceDetail'),
      requires: ['invoice:read'],
      titleKey: 'detail',
    },
  ],
  extensions: [
    {
      slot: 'encounter.detail.actions',
      component: () => import('./components/CreateInvoiceAction'),
      requires: ['invoice:create', 'charge:read', 'encounter:read'],
      order: 40,
    },
  ],
  permissions: [
    'charge:read',
    'invoice:read',
    'invoice:create',
    'invoice:issue',
    'invoice:adjust',
    'encounter:read',
  ],
};
