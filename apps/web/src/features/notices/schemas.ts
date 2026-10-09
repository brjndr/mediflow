import { z } from 'zod';
import type { Notice, NoticePage } from './types';

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const noticeSchema: z.ZodType<Notice> = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  archived: z.boolean(),
});

export const noticePageSchema: z.ZodType<NoticePage> = z.object({
  items: z.array(noticeSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
