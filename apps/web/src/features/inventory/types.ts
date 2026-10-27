import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * Stock (#102): the places that keep it, an item with its batches at each place, the
 * append-only ledger of every change, and adjustments asked for by one person and approved by
 * another. The endpoints are the inventory API's.
 */
export type StockLocation = Schemas['StockLocation'];
export type StockLocationPage = Schemas['StockLocationPage'];
export type StockLocationKind = Schemas['StockLocationKind'];
export type StockItem = Schemas['StockItem'];
export type StockItemName = Schemas['StockItemName'];
export type StockItemPage = Schemas['StockItemPage'];
export type StockBatchBalance = Schemas['StockBatchBalance'];
export type StockExpiryState = Schemas['StockExpiryState'];
export type StockAlertCounts = Schemas['StockAlertCounts'];
export type StockLedgerEntry = Schemas['StockLedgerEntry'];
export type StockLedgerPage = Schemas['StockLedgerPage'];
export type StockAdjustment = Schemas['StockAdjustment'];
export type StockAdjustmentPage = Schemas['StockAdjustmentPage'];
export type StockAdjustmentCreate = Schemas['StockAdjustmentCreate'];
export type StockAdjustmentReason = Schemas['StockAdjustmentReason'];
export type StockAdjustmentStatus = Schemas['StockAdjustmentStatus'];
export type StockAlert = 'low' | 'expiring' | 'expired';
