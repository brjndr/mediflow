import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  DocumentCategory,
  DocumentStatus,
  PatientDocument,
  PatientDocumentPage,
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
