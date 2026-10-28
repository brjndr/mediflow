import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  IndentPlace,
  IndentPlacePage,
  StockIndent,
  StockIndentPage,
  StockIndentStatus,
  StockItemName,
} from './types';

export const INDENT_STATUSES = [
  'requested',
  'approved',
  'partly_issued',
  'issued',
  'closed',
  'rejected',
  'cancelled',
] as const satisfies readonly StockIndentStatus[];

/** The API's limits. */
export const NOTE_MAX = 200;
export const INDENT_LINES_MAX = 100;
export const QUANTITY_MAX = 1_000_000;
export const ISSUE_LINES_MAX = 400;

const page = <Item>(item: z.ZodType<Item>) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

const itemNameSchema: z.ZodType<StockItemName> = z.object({
  drugId: z.string(),
  type: z.enum(['medicine', 'consumable']),
  genericName: z.string(),
  brandName: z.string().optional(),
  form: z.string(),
  strength: z.string().optional(),
  unit: z.string().optional(),
});

const placeSchema: z.ZodType<IndentPlace> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  kind: z.enum(['store', 'pharmacy', 'ward', 'department']),
  archived: z.boolean(),
  version: z.number().int(),
});
export const placePageSchema: z.ZodType<IndentPlacePage> = page(placeSchema);

const head = {
  id: z.string(),
  tenantId: z.string(),
  reference: z.string(),
  fromLocationId: z.string(),
  fromLocationName: z.string(),
  toLocationId: z.string(),
  toLocationName: z.string(),
  status: z.enum(INDENT_STATUSES),
  requestedById: z.string(),
  requestedByName: z.string(),
  requestedAt: z.string(),
  version: z.number().int(),
};

export const indentPageSchema: z.ZodType<StockIndentPage> = page(
  z.object({ ...head, lineCount: z.number().int() }),
);

export const indentSchema: z.ZodType<StockIndent> = z.object({
  ...head,
  note: z.string().optional(),
  decidedByName: z.string().optional(),
  decidedAt: z.string().optional(),
  rejectionNote: z.string().optional(),
  endedByName: z.string().optional(),
  endedAt: z.string().optional(),
  endNote: z.string().optional(),
  lines: z.array(
    z.object({
      id: z.string(),
      lineNumber: z.number().int(),
      item: itemNameSchema,
      requestedQuantity: z.number().int(),
      approvedQuantity: z.number().int().optional(),
      issuedQuantity: z.number().int(),
      storeOnHand: z.number().int().optional(),
      batches: z
        .array(
          z.object({
            batchId: z.string(),
            batchNumber: z.string(),
            expiryDate: z.string(),
            onHand: z.number().int(),
          }),
        )
        .optional(),
    }),
  ),
  issues: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      note: z.string().optional(),
      issuedByName: z.string(),
      issuedAt: z.string(),
      lines: z.array(
        z.object({
          indentLineId: z.string(),
          drugId: z.string(),
          batchId: z.string(),
          batchNumber: z.string(),
          expiryDate: z.string(),
          quantity: z.number().int(),
        }),
      ),
    }),
  ),
});

const plain = (max: number) =>
  z.string().trim().max(max, 'validation.too_big').regex(PLAIN_TEXT, 'validation.plain_text');

/** Whole units typed in a field; empty only where `required` is false. */
const wholeUnits = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((text) => (required ? text !== '' : true), 'validation.required')
    .refine((text) => text === '' || /^\d+$/.test(text), 'indents:form.wholeUnits')
    .refine(
      (text) => text === '' || (Number(text) >= 1 && Number(text) <= QUANTITY_MAX),
      'indents:form.unitsRange',
    );

/**
 * An indent as typed: the place that asks, the store asked (never the same), a note, and its
 * lines, each an item chosen with the search (its id and name held by the form) and whole units.
 */
export const indentFormSchema = z
  .object({
    fromLocationId: z.string().min(1, 'validation.required'),
    toLocationId: z.string().min(1, 'validation.required'),
    note: plain(NOTE_MAX),
    lines: z
      .array(z.object({ drugId: z.string(), name: z.string(), quantity: wholeUnits(true) }))
      .min(1, 'indents:form.noLines')
      .max(INDENT_LINES_MAX, 'validation.too_big'),
  })
  .refine((values) => values.fromLocationId !== values.toLocationId, {
    path: ['toLocationId'],
    message: 'indents:form.samePlace',
  });
export type IndentFormValues = z.output<typeof indentFormSchema>;

/** Units approved of each line: each up to what it asked (`asked`), at least one above 0. */
export function createApproveFormSchema(asked: number[]) {
  return z.object({ units: z.array(z.string().trim()) }).superRefine((values, context) => {
    const issue = (index: number, message: string) =>
      context.addIssue({ code: 'custom', path: ['units', index], message });
    values.units.forEach((units, index) => {
      if (units === '') issue(index, 'validation.required');
      else if (!/^\d+$/.test(units)) issue(index, 'indents:form.wholeUnits');
      else if (Number(units) > (asked[index] ?? 0)) issue(index, 'indents:approve.tooMany');
    });
    if (values.units.every((units) => /^\d+$/.test(units) && Number(units) === 0)) {
      issue(0, 'indents:approve.nothing');
    }
  });
}
export type ApproveFormValues = z.output<ReturnType<typeof createApproveFormSchema>>;

/**
 * Units issued from each batch offered, in the order of `rows` (each of a line): never more than
 * the batch has (`onHand`), a line's rows never more than it still has to issue (`left`, by line),
 * and something at least.
 */
export function createIssueFormSchema(
  rows: { lineId: string; onHand: number }[],
  left: Record<string, number>,
) {
  return z
    .object({ units: z.array(wholeUnits(false)), note: plain(NOTE_MAX) })
    .superRefine((values, context) => {
      const issue = (index: number, message: string) =>
        context.addIssue({ code: 'custom', path: ['units', index], message });
      const sent = values.units.filter((units) => units !== '').length;
      if (sent === 0) issue(0, 'indents:issue.nothing');
      if (sent > ISSUE_LINES_MAX) issue(0, 'indents:issue.tooManyRows');
      const coming: Record<string, number> = {};
      values.units.forEach((units, index) => {
        const row = rows[index];
        if (units === '' || !row) return;
        if (Number(units) > row.onHand) issue(index, 'indents:issue.moreThanBatch');
        const sum = (coming[row.lineId] ?? 0) + Number(units);
        coming[row.lineId] = sum;
        if (sum > (left[row.lineId] ?? 0)) issue(index, 'indents:issue.tooMany');
      });
    });
}
export type IssueFormValues = z.output<ReturnType<typeof createIssueFormSchema>>;

export const endFormSchema = z.object({
  note: plain(NOTE_MAX).min(1, 'indents:end.noteRequired'),
});
export type EndFormValues = z.infer<typeof endFormSchema>;
