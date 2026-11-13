import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ProgressNote,
  ProgressNoteKind,
  ProgressNotePage,
  ProgressNoteVersion,
  ProgressNoteVersionPage,
} from './types';

export const NOTE_KINDS = [
  'observation',
  'nursing',
  'handover',
] as const satisfies ProgressNoteKind[];
export const NOTE_MAX = 4000;

export const progressNoteSchema: z.ZodType<ProgressNote> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  kind: z.enum(NOTE_KINDS),
  body: z.string(),
  createdAt: z.string(),
  createdById: z.string(),
  createdByName: z.string(),
  updatedAt: z.string(),
  updatedById: z.string(),
  version: z.number().int(),
});

export const progressNotePageSchema: z.ZodType<ProgressNotePage> = z.object({
  items: z.array(progressNoteSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const versionSchema: z.ZodType<ProgressNoteVersion> = z.object({
  version: z.number().int(),
  body: z.string(),
  editedAt: z.string(),
  editedById: z.string(),
  editedByName: z.string(),
});

export const noteVersionPageSchema: z.ZodType<ProgressNoteVersionPage> = z.object({
  items: z.array(versionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

// --- the forms ---------------------------------------------------------------------------------

const body = z
  .string()
  .trim()
  .min(1, 'nursing:notes.errors.body')
  .max(NOTE_MAX, 'nursing:notes.errors.bodyLong')
  .regex(PLAIN_TEXT, 'validation.plain_text');

export const noteFormSchema = z.object({ kind: z.enum(NOTE_KINDS), body });
export type NoteValues = z.infer<typeof noteFormSchema>;

export const noteEditSchema = z.object({ body });
export type NoteEditValues = z.infer<typeof noteEditSchema>;
