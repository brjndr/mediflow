import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  DocumentCategory,
  DocumentStatus,
  LegalHold,
  LegalHoldPage,
  PatientDocument,
  PatientDocumentPage,
  RetentionRule,
} from './types';

export const DOCUMENT_CATEGORIES = [
  'consent',
  'referral_letter',
  'outside_report',
  'id_proof',
  'insurance',
  'certificate',
  'other',
] as const satisfies readonly DocumentCategory[];

/** The API's limits (`apps/api/src/features/documents/schemas.ts`). */
export const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const TITLE_MAX = 200;
export const REASON_MAX = 300;
export const DOCUMENT_PAGE_SIZE = 25;

const STATUSES = [
  'pending',
  'scanning',
  'clean',
  'infected',
  'failed',
  'purged',
] as const satisfies readonly DocumentStatus[];

export const documentSchema: z.ZodType<PatientDocument> = z.object({
  id: z.string(),
  patientId: z.string(),
  encounterId: z.string().optional(),
  category: z.enum(DOCUMENT_CATEGORIES),
  title: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  status: z.enum(STATUSES),
  retainUntil: z.string().optional(),
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional(),
  held: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
});

export const documentPageSchema: z.ZodType<PatientDocumentPage> = z.object({
  items: z.array(documentSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const uploadSchema = z.object({
  document: documentSchema,
  uploadUrl: z.string(),
  expiresAt: z.string(),
});

export const downloadSchema = z.object({ url: z.string(), expiresAt: z.string() });

/** The file's type and size, checked before anything is sent; the API checks both again. */
export function fileProblem(file: { type: string; size: number }): string | undefined {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(file.type)) return 'upload.errors.type';
  if (file.size < 1) return 'upload.errors.empty';
  if (file.size > DOCUMENT_MAX_BYTES) return 'upload.errors.size';
  return undefined;
}

export const uploadFormSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  title: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(TITLE_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type UploadValues = z.infer<typeof uploadFormSchema>;

export const retireFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type RetireValues = z.infer<typeof retireFormSchema>;

/** How often the list is read again while a file waits for its malware scan. */
export const SCAN_POLL_MS = 5000;

export const RETENTION_MAX_YEARS = 100;

export const retentionRulesSchema: z.ZodType<{ items: RetentionRule[] }> = z.object({
  items: z.array(
    z.object({
      category: z.enum(DOCUMENT_CATEGORIES),
      years: z.number().int().nullable(),
    }),
  ),
});

export const retentionSetSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  years: z.number().int().nullable(),
});

/** Years typed as digits, or "keep for ever"; the number is worked out on submit. */
export const retentionFormSchema = z
  .object({ years: z.string().trim(), forever: z.boolean() })
  .superRefine((value, ctx) => {
    if (value.forever) return;
    if (value.years === '') {
      ctx.addIssue({ code: 'custom', path: ['years'], message: 'validation.required' });
    } else if (
      !/^\d+$/.test(value.years) ||
      Number(value.years) < 1 ||
      Number(value.years) > RETENTION_MAX_YEARS
    ) {
      ctx.addIssue({ code: 'custom', path: ['years'], message: 'validation.invalid_format' });
    }
  });
export type RetentionValues = z.infer<typeof retentionFormSchema>;

export const HOLD_PAGE_SIZE = 25;

export const holdSchema: z.ZodType<LegalHold> = z.object({
  id: z.string(),
  patientId: z.string(),
  documentId: z.string().optional(),
  reason: z.string(),
  placedAt: z.string(),
  releasedAt: z.string().optional(),
});

export const holdPageSchema: z.ZodType<LegalHoldPage> = z.object({
  items: z.array(holdSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const holdFormSchema = retireFormSchema;
export type HoldValues = RetireValues;
