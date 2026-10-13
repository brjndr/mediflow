import { z } from 'zod';
import { sanitizeRichText } from '@/shared/ui/rich-text';
import { TEMPLATE_KINDS } from './placeholders';
import { REDACTION_REASONS, type Template, type TemplatePage } from './types';
import { PLAIN_TEXT } from '@/shared/utils/text';

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const templateSchema: z.ZodType<Template> = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string(),
  version: z.number().int().min(1),
  savedAt: z.string(),
  archived: z.boolean(),
});

export const templatePageSchema: z.ZodType<TemplatePage> = z.object({
  items: z.array(templateSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const versionInfo = {
  version: z.number().int().min(1),
  savedAt: z.string(),
  savedByName: z.string(),
  // Present once the name and the text of the version were removed.
  redactedAt: z.string().optional(),
};
// Whatever text arrives is reduced to the rich text allowlist before a screen sees it.
const body = z.unknown().transform((value) => sanitizeRichText(value));

export const templateDetailSchema = z.object({
  template: templateSchema,
  body,
  versions: z.array(z.object(versionInfo)),
});

export const templateVersionSchema = z.object({
  ...versionInfo,
  name: z.string(),
  body,
  redactedByName: z.string().optional(),
  redactionReason: z.enum(REDACTION_REASONS).optional(),
});

export const NAME_MAX = 100;

/** The name of a template, and for a new one its kind. Messages are keys in core `common`. */
export const templateFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NAME_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type TemplateFormValues = z.infer<typeof templateFormSchema>;

/** The reason a version is redacted for. */
export const redactFormSchema = z.object({
  reason: z.enum(REDACTION_REASONS, 'validation.required'),
});
export type RedactFormValues = z.infer<typeof redactFormSchema>;

export const templateCreateFormSchema = templateFormSchema.extend({
  kind: z.enum(TEMPLATE_KINDS, 'validation.required'),
});
export type TemplateCreateFormValues = z.infer<typeof templateCreateFormSchema>;
