// Public surface of the API contract. apps/web imports types from here only.
export type { paths, components, operations } from './generated/api';

/** Cursor-paginated list envelope used by every list endpoint. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
