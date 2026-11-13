import { z } from 'zod';
import { sanitizeRichText } from '@/shared/ui/rich-text';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  Certificate,
  CertificateField,
  CertificateFieldType,
  CertificateKind,
  CertificateFormat,
  CertificatePage,
  Consent,
  ConsentDetail,
  ConsentPage,
  ConsentSignature,
  ConsentSigner,
} from './types';

export const CONSENTS_PAGE_SIZE = 25;
export const NAME_MAX = 200;
export const FIELD_MAX = 500;

export const SIGNERS = [
  'patient',
  'guardian',
  'representative',
] as const satisfies readonly ConsentSigner[];
export const SIGNATURES = ['drawn', 'typed'] as const satisfies readonly ConsentSignature[];
export const CERTIFICATE_KINDS = [
  'medical',
  'fitness',
  'birth',
  'death',
] as const satisfies readonly CertificateKind[];

export const FIELD_TYPES = [
  'text',
  'lines',
  'date',
  'time',
  'select',
] as const satisfies readonly CertificateFieldType[];

/** The box a drawn signature lives in, and the most path data the API takes. */
export const PAD_WIDTH = 300;
export const PAD_HEIGHT = 150;
export const SIGNATURE_MAX = 20_000;
/** Path data made of the letters we draw with and numbers only: safe to put in an SVG `d`. */
export const SIGNATURE_PATH = /^[ML0-9 .,-]*$/;

export const consentSchema: z.ZodType<Consent> = z.object({
  id: z.string(),
  patientId: z.string(),
  procedureName: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int(),
  signerName: z.string(),
  signerRole: z.enum(SIGNERS),
  signatureMethod: z.enum(SIGNATURES),
  signedAt: z.string(),
  signedByName: z.string(),
});

export const consentPageSchema: z.ZodType<ConsentPage> = z.object({
  items: z.array(consentSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const consentDetailSchema = z
  .object({
    consent: consentSchema,
    body: z.unknown(),
    signature: z.string().regex(SIGNATURE_PATH).max(SIGNATURE_MAX).optional(),
  })
  .transform((detail): ConsentDetail => ({ ...detail, body: sanitizeRichText(detail.body) }));

export const certificateFieldSchema: z.ZodType<CertificateField> = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const certificateFormatSchema: z.ZodType<CertificateFormat> = z.object({
  kind: z.enum(CERTIFICATE_KINDS),
  fields: z.array(certificateFieldSchema),
  custom: z.boolean(),
});

export const certificateFormatListSchema = z.object({ items: z.array(certificateFormatSchema) });

export const certificateSchema: z.ZodType<Certificate> = z.object({
  id: z.string(),
  patientId: z.string(),
  kind: z.enum(CERTIFICATE_KINDS),
  number: z.string(),
  issuedOn: z.string(),
  fields: z.record(z.string(), z.string()),
  layout: z.array(certificateFieldSchema),
  issuedByName: z.string(),
  issuedAt: z.string(),
});

export const certificatePageSchema: z.ZodType<CertificatePage> = z.object({
  items: z.array(certificateSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const plainName = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .max(NAME_MAX, 'validation.too_big')
  .regex(PLAIN_TEXT, 'validation.plain_text');

/** The consent form: which text, for what, and who signs. The signature itself is the pad's. */
export const consentFormSchema = z.object({
  templateId: z.string().min(1, 'validation.required'),
  procedureName: plainName,
  signerName: plainName,
  signerRole: z.enum(SIGNERS),
});
export type ConsentValues = z.infer<typeof consentFormSchema>;

/**
 * The standard fields of each kind: what a hospital gets until it changes them (#567). The server
 * holds the same list; the mock reads this one. Names are what the API stores values under.
 */
export const STANDARD_FIELDS: Record<CertificateKind, readonly CertificateField[]> = {
  medical: [
    { name: 'diagnosis', type: 'lines', required: true },
    { name: 'restFrom', type: 'date', required: true },
    { name: 'restTo', type: 'date', required: true },
    { name: 'remarks', type: 'lines', required: false },
  ],
  fitness: [
    { name: 'purpose', type: 'text', required: true },
    { name: 'findings', type: 'lines', required: false },
    {
      name: 'outcome',
      type: 'select',
      required: true,
      options: ['fit', 'fit_with_conditions', 'unfit'],
    },
    { name: 'validUntil', type: 'date', required: false },
  ],
  birth: [
    { name: 'childName', type: 'text', required: false },
    { name: 'dateOfBirth', type: 'date', required: true },
    { name: 'timeOfBirth', type: 'time', required: false },
    { name: 'sex', type: 'select', required: true, options: ['female', 'male', 'other'] },
    { name: 'placeOfBirth', type: 'text', required: true },
    { name: 'motherName', type: 'text', required: true },
    { name: 'fatherName', type: 'text', required: false },
  ],
  death: [
    { name: 'deceasedName', type: 'text', required: true },
    { name: 'dateOfDeath', type: 'date', required: true },
    { name: 'timeOfDeath', type: 'time', required: false },
    { name: 'placeOfDeath', type: 'text', required: true },
    { name: 'causeOfDeath', type: 'lines', required: true },
    {
      name: 'manner',
      type: 'select',
      required: true,
      options: ['natural', 'accident', 'suicide', 'homicide', 'undetermined'],
    },
  ],
};

export const FIELDS_MAX = 30;
export const LABEL_MAX = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const text = z.string().trim().max(FIELD_MAX, 'validation.too_big');

function fieldSchema(field: CertificateField): z.ZodType<string, string> {
  let base: z.ZodType<string, string>;
  switch (field.type) {
    case 'date':
      base = z.string().regex(DATE, 'validation.invalid_format');
      break;
    case 'time':
      base = z.string().regex(TIME, 'validation.invalid_format');
      break;
    case 'select':
      base = z
        .string()
        .refine((value) => (field.options ?? []).includes(value), 'validation.invalid_format');
      break;
    case 'lines':
      base = text.regex(PLAIN_LINES, 'validation.plain_text');
      break;
    default:
      base = text.regex(PLAIN_TEXT, 'validation.plain_text');
  }
  return field.required
    ? z.string().trim().min(1, 'validation.required').pipe(base)
    : z.union([z.literal(''), base]);
}

/** The form of one kind of certificate: the day it is issued on and its fields. */
export function certificateFormSchema(fields: readonly CertificateField[]) {
  const shape: Record<string, z.ZodType<string, string>> = {};
  for (const field of fields) shape[field.name] = fieldSchema(field);
  return z
    .object({ issuedOn: z.string().regex(DATE, 'validation.required'), fields: z.object(shape) })
    .superRefine((value, context) => {
      // A rest never ends before it starts.
      const { restFrom, restTo } = value.fields as Record<string, string | undefined>;
      if (restFrom && restTo && restTo < restFrom) {
        context.addIssue({
          code: 'custom',
          path: ['fields', 'restTo'],
          message: 'validation.invalid_format',
        });
      }
    });
}
export type CertificateValues = { issuedOn: string; fields: Record<string, string> };

export function emptyCertificate(
  fields: readonly CertificateField[],
  today: string,
): CertificateValues {
  return {
    issuedOn: today,
    fields: Object.fromEntries(fields.map((field) => [field.name, ''])),
  };
}

/** One field as the format editor holds it: options are typed one to a line. */
const editorFieldSchema = z
  .object({
    name: z.string(),
    label: z
      .string()
      .trim()
      .max(LABEL_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    standard: z.boolean(),
    optionsText: z
      .string()
      .max(2000, 'validation.too_big')
      .regex(PLAIN_LINES, 'validation.plain_text'),
  })
  .superRefine((field, context) => {
    // A field of the hospital's own has no standard label to fall back on.
    if (!field.standard && field.label === '') {
      context.addIssue({ code: 'custom', path: ['label'], message: 'validation.required' });
    }
    if (field.type === 'select') {
      const options = optionsOf(field.optionsText);
      if (options.length === 0 || options.length > 20 || new Set(options).size !== options.length) {
        context.addIssue({
          code: 'custom',
          path: ['optionsText'],
          message: 'validation.invalid_format',
        });
      }
    }
  });

export const formatEditorSchema = z.object({
  fields: z
    .array(editorFieldSchema)
    .min(1, 'validation.required')
    .max(FIELDS_MAX, 'validation.too_big'),
});
export type FormatEditorValues = z.infer<typeof formatEditorSchema>;
export type EditorField = FormatEditorValues['fields'][number];

export const optionsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function toEditor(
  fields: readonly CertificateField[],
  kind: CertificateKind,
): FormatEditorValues {
  const standard = new Set(STANDARD_FIELDS[kind].map((field) => field.name));
  return {
    fields: fields.map((field) => ({
      name: field.name,
      label: field.label ?? '',
      type: field.type,
      required: field.required,
      standard: standard.has(field.name),
      optionsText: (field.options ?? []).join('\n'),
    })),
  };
}

/** The request: a standard field with no label of its own keeps the screen's label. */
export function fromEditor(values: FormatEditorValues): CertificateField[] {
  return values.fields.map((field) => ({
    name: field.name,
    ...(field.label !== '' ? { label: field.label } : {}),
    type: field.type,
    required: field.required,
    ...(field.type === 'select' ? { options: optionsOf(field.optionsText) } : {}),
  }));
}

/** A name for a field the hospital adds: never one already in the list. */
export function newFieldName(taken: readonly string[]): string {
  let n = 1;
  while (taken.includes(`custom${n}`)) n += 1;
  return `custom${n}`;
}
