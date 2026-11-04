import { Receipt } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Billing (#109): the invoice builder. A visit's pending charges and lines typed in are saved as
 * a draft and issued. The charge ledger and invoices are the billing API's (#114); until it
 * exists the screens run on the mock. Reached from a consultation (`encounter.detail.actions`),
 * and, since #110, the invoice list (`billing/invoices`) with its print view.
 */
export const billingFeature: FeatureManifest = {
  id: 'billing',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Billing',
        list: 'Invoices',
        new: 'New invoice',
        detail: 'Invoice',
        register: 'Cash register',
        sessions: 'Register sessions',
        session: 'Register session',
        taxRates: 'Tax rates',
        discountLimit: 'Discount limit',
        packages: 'Package contents',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  featureFlag: 'billing',
  nav: { icon: Receipt, order: 29.9, requires: ['invoice:read'] },
  routes: [
    {
      path: 'billing/invoices',
      lazy: () => import('./routes/InvoiceList'),
      requires: ['invoice:read'],
      titleKey: 'list',
    },
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
    {
      path: 'billing/register',
      lazy: () => import('./routes/Register'),
      requires: ['cashRegister:manage'],
      titleKey: 'register',
    },
    {
      path: 'billing/register/sessions',
      lazy: () => import('./routes/RegisterSessions'),
      requires: ['cashRegister:read'],
      titleKey: 'sessions',
    },
    {
      path: 'billing/register/sessions/:sessionId',
      lazy: () => import('./routes/RegisterSessionDetail'),
      requires: ['cashRegister:read'],
      titleKey: 'session',
    },
    {
      path: 'billing/tax-rates',
      lazy: () => import('./routes/TaxRates'),
      requires: ['taxRate:manage', 'invoice:read'],
      titleKey: 'taxRates',
    },
    {
      path: 'billing/discount-limit',
      lazy: () => import('./routes/DiscountLimit'),
      requires: ['discount:manage', 'invoice:read'],
      titleKey: 'discountLimit',
    },
    {
      path: 'billing/packages',
      lazy: () => import('./routes/Packages'),
      requires: ['package:manage', 'charge:read', 'service:read'],
      titleKey: 'packages',
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
    'charge:create',
    'invoice:read',
    'invoice:create',
    'invoice:issue',
    'invoice:print',
    'invoice:adjust',
    'payment:read',
    'payment:create',
    'creditNote:create',
    'cashRegister:read',
    'cashRegister:manage',
    'taxRate:manage',
    'package:manage',
    'service:read',
    'discount:apply',
    'discount:approve',
    'discount:manage',
    'encounter:read',
  ],
};
