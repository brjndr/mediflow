import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/**
 * Indents (#105): a place asks a store for items, someone else approves it, and the store issues
 * it on vouchers. The endpoints are the inventory API's (`/inventory/indents`).
 */
export type StockIndent = Schemas['StockIndent'];
export type StockIndentLine = Schemas['StockIndentLine'];
export type StockIndentSummary = Schemas['StockIndentSummary'];
export type StockIndentPage = Schemas['StockIndentPage'];
export type StockIndentStatus = Schemas['StockIndentStatus'];
export type StockIndentCreate = Schemas['StockIndentCreate'];
export type StockIssue = Schemas['StockIssue'];
export type StockIssueCreate = Schemas['StockIssueCreate'];
export type StockItemName = Schemas['StockItemName'];
export type IndentPlace = Schemas['StockLocation'];
export type IndentPlacePage = Schemas['StockLocationPage'];
