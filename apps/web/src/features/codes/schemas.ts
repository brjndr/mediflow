import { z } from 'zod';
import type { Code, CodePage } from './types';

export const CODE_SYSTEMS = ['icd10', 'procedure'] as const;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const codeSchema: z.ZodType<Code> = z.object({
  id: z.string(),
  system: z.enum(CODE_SYSTEMS),
  code: z.string(),
  title: z.string(),
  favourite: z.boolean(),
});

export const codePageSchema: z.ZodType<CodePage> = z.object({
  items: z.array(codeSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
