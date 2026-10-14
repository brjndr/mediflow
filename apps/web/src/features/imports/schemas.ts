import { z } from 'zod';
import type {
  ImportBatch,
  ImportBatchPage,
  ImportColumn,
  ImportKind,
  ImportProblemPage,
} from './types';

export const STATUSES = [
  'staging',
  'checking',
  'checked',
  'queued',
  'running',
  'committed',
  'failed',
  'cancelled',
] as const satisfies readonly ImportBatch['status'][];

/** While a batch is in one of these, a job is working on it and the screen follows it. */
export const WORKING: readonly ImportBatch['status'][] = ['checking', 'queued', 'running'];

/** The kinds the app has words for. A kind the API offers that is not here is not shown. */
export const KINDS = ['services', 'drugs', 'lab_tests', 'patients'] as const;
export type KnownKind = (typeof KINDS)[number];
export const isKnownKind = (kind: string): kind is KnownKind =>
  (KINDS as readonly string[]).includes(kind);

/** The most a file may hold, as the API holds a batch. */
export const MAX_ROWS = 20_000;
export const MAX_FILE_BYTES = 5_000_000;
/** Rows sent in one request. */
export const CHUNK_ROWS = 1_000;
/** The longest text one field may be. */
export const VALUE_MAX = 2_000;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const batchSchema: z.ZodType<ImportBatch> = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.string(),
  status: z.enum(STATUSES),
  rowCount: z.number().int().min(0),
  doneCount: z.number().int().min(0),
  problemCount: z.number().int().min(0),
  failure: z.string().optional(),
  createdBy: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.string(),
  checkedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const batchPageSchema: z.ZodType<ImportBatchPage> = z.object({
  items: z.array(batchSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const columnSchema: z.ZodType<ImportColumn> = z.object({
  field: z.string(),
  required: z.boolean(),
  type: z.enum(['text', 'integer', 'boolean', 'enum', 'date', 'amount']),
  values: z.array(z.string()).optional(),
});

export const kindListSchema: z.ZodType<{ items: ImportKind[] }> = z.object({
  items: z.array(z.object({ kind: z.string(), columns: z.array(columnSchema) })),
});

export const problemPageSchema: z.ZodType<ImportProblemPage> = z.object({
  items: z.array(
    z.object({ line: z.number().int().min(1), field: z.string().optional(), code: z.string() }),
  ),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** The text of a header or a field name, for matching one with the other. */
export const comparable = (text: string): string =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export type Mapping = Record<string, string>;

/**
 * The mapping form: for each field of the kind, the column of the file it is read from (its
 * position, as text), or nothing. A required field needs one, and a column fills one field.
 * Messages are translation keys of this feature.
 */
export function mappingSchema(columns: readonly ImportColumn[]): z.ZodType<Mapping, Mapping> {
  const shape = Object.fromEntries(columns.map((column) => [column.field, z.string()]));
  return z.object(shape).superRefine((values, context) => {
    const used = new Set<string>();
    for (const column of columns) {
      const chosen = values[column.field] ?? '';
      if (chosen === '') {
        if (column.required) {
          context.addIssue({
            code: 'custom',
            path: [column.field],
            message: 'imports:mapping.required',
          });
        }
        continue;
      }
      if (used.has(chosen)) {
        context.addIssue({
          code: 'custom',
          path: [column.field],
          message: 'imports:mapping.twice',
        });
      }
      used.add(chosen);
    }
  });
}

/** The column each field is most likely read from: one whose title is the field's name or label. */
export function guessMapping(
  columns: readonly ImportColumn[],
  headers: readonly string[],
  labelOf: (field: string) => string,
): Mapping {
  const titles = headers.map(comparable);
  const taken = new Set<number>();
  const mapping: Mapping = {};
  for (const column of columns) {
    const names = new Set([comparable(column.field), comparable(labelOf(column.field))]);
    const at = titles.findIndex((title, index) => !taken.has(index) && names.has(title));
    if (at >= 0) taken.add(at);
    mapping[column.field] = at >= 0 ? String(at) : '';
  }
  return mapping;
}
