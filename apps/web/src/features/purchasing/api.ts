import { api, requireData } from '@/shared/api';
import {
  orderPageSchema,
  orderSchema,
  receiptPageSchema,
  receiptSchema,
  returnPageSchema,
  returnSchema,
  supplierPageSchema,
  supplierSchema,
} from './schemas';
import type {
  GoodsReceipt,
  GoodsReceiptCreate,
  GoodsReceiptPage,
  PurchaseOrder,
  PurchaseOrderCreate,
  PurchaseOrderPage,
  PurchaseOrderStatus,
  PurchaseOrderUpdate,
  PurchaseReturn,
  PurchaseReturnCreate,
  PurchaseReturnPage,
  Supplier,
  SupplierCreate,
  SupplierPage,
  SupplierUpdate,
} from './types';

// Every address holds ids, a status or a supplier's name: nothing about a patient, so these are
// GETs. Every POST carries an idempotency key.

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export async function fetchSuppliers(
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<SupplierPage> {
  const result = await api.GET('/purchasing/suppliers', {
    params: { query: { archived, cursor, limit } },
    signal,
  });
  return supplierPageSchema.parse(requireData(result));
}

export async function createSupplier(body: SupplierCreate, key: string): Promise<Supplier> {
  const result = await api.POST('/purchasing/suppliers', { body, params: idempotent(key) });
  return supplierSchema.parse(requireData(result));
}

export async function updateSupplier(supplierId: string, body: SupplierUpdate): Promise<Supplier> {
  const result = await api.PATCH('/purchasing/suppliers/{supplierId}', {
    body,
    params: { path: { supplierId } },
  });
  return supplierSchema.parse(requireData(result));
}

export async function setSupplierArchived(
  supplierId: string,
  archived: boolean,
): Promise<Supplier> {
  const result = archived
    ? await api.POST('/purchasing/suppliers/{supplierId}/archive', {
        params: { path: { supplierId } },
      })
    : await api.POST('/purchasing/suppliers/{supplierId}/restore', {
        params: { path: { supplierId } },
      });
  return supplierSchema.parse(requireData(result));
}

export async function fetchOrders(
  { status, cursor, limit }: { status: PurchaseOrderStatus | ''; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PurchaseOrderPage> {
  const result = await api.GET('/purchasing/orders', {
    params: { query: { status: status || undefined, cursor, limit } },
    signal,
  });
  return orderPageSchema.parse(requireData(result));
}

export async function fetchOrder(orderId: string, signal?: AbortSignal): Promise<PurchaseOrder> {
  const result = await api.GET('/purchasing/orders/{orderId}', {
    params: { path: { orderId } },
    signal,
  });
  return orderSchema.parse(requireData(result));
}

export async function createOrder(body: PurchaseOrderCreate, key: string): Promise<PurchaseOrder> {
  const result = await api.POST('/purchasing/orders', { body, params: idempotent(key) });
  return orderSchema.parse(requireData(result));
}

export async function updateOrder(
  orderId: string,
  body: PurchaseOrderUpdate,
): Promise<PurchaseOrder> {
  const result = await api.PATCH('/purchasing/orders/{orderId}', {
    body,
    params: { path: { orderId } },
  });
  return orderSchema.parse(requireData(result));
}

export type OrderStep = 'submit' | 'approve' | 'cancel' | 'close';

export async function stepOrder(
  orderId: string,
  step: OrderStep,
  body: { expectedVersion: number; note?: string },
  key: string,
): Promise<PurchaseOrder> {
  const params = { path: { orderId }, ...idempotent(key) };
  const note = body.note ?? '';
  const result =
    step === 'submit'
      ? await api.POST('/purchasing/orders/{orderId}/submit', { body, params })
      : step === 'approve'
        ? await api.POST('/purchasing/orders/{orderId}/approve', { body, params })
        : step === 'cancel'
          ? await api.POST('/purchasing/orders/{orderId}/cancel', {
              body: { expectedVersion: body.expectedVersion, note },
              params,
            })
          : await api.POST('/purchasing/orders/{orderId}/close', {
              body: { expectedVersion: body.expectedVersion, note },
              params,
            });
  return orderSchema.parse(requireData(result));
}

export async function fetchReceipts(
  { orderId, cursor, limit }: { orderId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<GoodsReceiptPage> {
  const result = await api.GET('/purchasing/receipts', {
    params: { query: { orderId: orderId || undefined, cursor, limit } },
    signal,
  });
  return receiptPageSchema.parse(requireData(result));
}

export async function fetchReceipt(receiptId: string, signal?: AbortSignal): Promise<GoodsReceipt> {
  const result = await api.GET('/purchasing/receipts/{receiptId}', {
    params: { path: { receiptId } },
    signal,
  });
  return receiptSchema.parse(requireData(result));
}

export async function receiveGoods(
  orderId: string,
  body: GoodsReceiptCreate,
  key: string,
): Promise<GoodsReceipt> {
  const result = await api.POST('/purchasing/orders/{orderId}/receipts', {
    body,
    params: { path: { orderId }, ...idempotent(key) },
  });
  return receiptSchema.parse(requireData(result));
}

export async function fetchReturns(
  { receiptId, cursor, limit }: { receiptId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<PurchaseReturnPage> {
  const result = await api.GET('/purchasing/returns', {
    params: { query: { receiptId: receiptId || undefined, cursor, limit } },
    signal,
  });
  return returnPageSchema.parse(requireData(result));
}

export async function returnToSupplier(
  receiptId: string,
  body: PurchaseReturnCreate,
  key: string,
): Promise<PurchaseReturn> {
  const result = await api.POST('/purchasing/receipts/{receiptId}/returns', {
    body,
    params: { path: { receiptId }, ...idempotent(key) },
  });
  return returnSchema.parse(requireData(result));
}
