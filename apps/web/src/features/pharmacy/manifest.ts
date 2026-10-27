import { Pill } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The pharmacy (#100): the queue of prescriptions to dispense, and dispensing each line from
 * batches at a place, nearest expiry first, in full or in part, with a generic substitute and a
 * warning of the patient's allergies, and the dispense slip printed. Stock leaves through the
 * inventory ledger. Counter sales with their returns and receipts, and the drug register of every
 * movement of a Schedule H1, X, narcotic or controlled item (#101). Works at every width.
 */
export const pharmacyFeature: FeatureManifest = {
  id: 'pharmacy',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Pharmacy',
        dispense: 'Dispense prescription',
        sales: 'Counter sales',
        newSale: 'New counter sale',
        sale: 'Counter sale',
        register: 'Drug register',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'pharmacy',
  routes: [
    { path: 'pharmacy', lazy: () => import('./routes/PharmacyQueue'), requires: ['dispense:read'] },
    {
      path: 'pharmacy/prescriptions/:prescriptionId',
      titleKey: 'dispense',
      lazy: () => import('./routes/DispensePrescription'),
      requires: ['dispense:read'],
    },
    {
      path: 'pharmacy/sales',
      titleKey: 'sales',
      lazy: () => import('./routes/SalesList'),
      requires: ['sale:read'],
    },
    {
      path: 'pharmacy/sales/new',
      titleKey: 'newSale',
      lazy: () => import('./routes/NewSale'),
      requires: ['sale:create', 'sale:read'],
    },
    {
      path: 'pharmacy/sales/:saleId',
      titleKey: 'sale',
      lazy: () => import('./routes/SaleDetail'),
      requires: ['sale:read'],
    },
    {
      path: 'pharmacy/register',
      titleKey: 'register',
      lazy: () => import('./routes/DrugRegister'),
      requires: ['drugRegister:read'],
    },
  ],
  nav: { icon: Pill, order: 29.75, requires: ['dispense:read'] },
  permissions: [
    'dispense:read',
    'dispense:create',
    'sale:read',
    'sale:create',
    'sale:return',
    'drugRegister:read',
  ],
};
