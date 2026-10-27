import { Truck } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Purchasing (#103): the hospital's suppliers, purchase orders drafted and submitted by one
 * person and approved by another, goods received against them (batches, expiry dates and costs
 * coming into stock through the inventory ledger), and goods sent back to the supplier. Works at
 * every width.
 */
export const purchasingFeature: FeatureManifest = {
  id: 'purchasing',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Purchasing',
        newOrder: 'New purchase order',
        order: 'Purchase order',
        editOrder: 'Edit purchase order',
        receipts: 'Goods receipts',
        receipt: 'Goods receipt',
        returns: 'Returns to suppliers',
        suppliers: 'Suppliers',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'purchasing',
  routes: [
    {
      path: 'purchasing',
      lazy: () => import('./routes/PurchaseOrders'),
      requires: ['purchaseOrder:read'],
    },
    {
      path: 'purchasing/orders/new',
      titleKey: 'newOrder',
      lazy: () => import('./routes/OrderEditor'),
      requires: ['purchaseOrder:create', 'purchaseOrder:read', 'supplier:read'],
    },
    {
      path: 'purchasing/orders/:orderId',
      titleKey: 'order',
      lazy: () => import('./routes/PurchaseOrderDetail'),
      requires: ['purchaseOrder:read'],
    },
    {
      path: 'purchasing/orders/:orderId/edit',
      titleKey: 'editOrder',
      lazy: () => import('./routes/OrderEditor'),
      requires: ['purchaseOrder:create', 'purchaseOrder:read', 'supplier:read'],
    },
    {
      path: 'purchasing/receipts',
      titleKey: 'receipts',
      lazy: () => import('./routes/GoodsReceipts'),
      requires: ['purchaseOrder:read'],
    },
    {
      path: 'purchasing/receipts/:receiptId',
      titleKey: 'receipt',
      lazy: () => import('./routes/GoodsReceiptDetail'),
      requires: ['purchaseOrder:read'],
    },
    {
      path: 'purchasing/returns',
      titleKey: 'returns',
      lazy: () => import('./routes/PurchaseReturns'),
      requires: ['purchaseOrder:read'],
    },
    {
      path: 'purchasing/suppliers',
      titleKey: 'suppliers',
      lazy: () => import('./routes/Suppliers'),
      requires: ['supplier:read'],
    },
  ],
  nav: { icon: Truck, order: 29.85, requires: ['purchaseOrder:read'] },
  permissions: [
    'supplier:read',
    'supplier:manage',
    'purchaseOrder:read',
    'purchaseOrder:create',
    'purchaseOrder:approve',
    'goodsReceipt:create',
    'purchaseReturn:create',
  ],
};
