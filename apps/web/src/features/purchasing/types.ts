import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * Purchasing (#103): suppliers, purchase orders submitted by one person and approved by another,
 * goods received against them into stock, and goods sent back. The endpoints are the purchasing
 * API's.
 */
export type Supplier = Schemas['Supplier'];
export type SupplierPage = Schemas['SupplierPage'];
export type SupplierCreate = Schemas['SupplierCreate'];
export type SupplierUpdate = Schemas['SupplierUpdate'];
export type PurchaseOrder = Schemas['PurchaseOrder'];
export type PurchaseOrderLine = Schemas['PurchaseOrderLine'];
export type PurchaseOrderSummary = Schemas['PurchaseOrderSummary'];
export type PurchaseOrderPage = Schemas['PurchaseOrderPage'];
export type PurchaseOrderStatus = Schemas['PurchaseOrderStatus'];
export type PurchaseOrderCreate = Schemas['PurchaseOrderCreate'];
export type PurchaseOrderUpdate = Schemas['PurchaseOrderUpdate'];
export type GoodsReceipt = Schemas['GoodsReceipt'];
export type GoodsReceiptLine = Schemas['GoodsReceiptLine'];
export type GoodsReceiptSummary = Schemas['GoodsReceiptSummary'];
export type GoodsReceiptPage = Schemas['GoodsReceiptPage'];
export type GoodsReceiptCreate = Schemas['GoodsReceiptCreate'];
export type PurchaseReturn = Schemas['PurchaseReturn'];
export type PurchaseReturnPage = Schemas['PurchaseReturnPage'];
export type PurchaseReturnReason = Schemas['PurchaseReturnReason'];
export type PurchaseReturnCreate = Schemas['PurchaseReturnCreate'];
