import { z } from 'zod';
import { sanitizeRichText } from '@/shared/ui/rich-text';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  Certificate,
  CertificateKind,
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

export const certificateSchema: z.ZodType<Certificate> = z.object({
  id: z.string(),
  patientId: z.string(),
  kind: z.enum(CERTIFICATE_KINDS),
  number: z.string(),
  issuedOn: z.string(),
  fields: z.record(z.string(), z.string()),
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

/** The fields of a certificate, by kind. Names are what the API stores them under. */
export type CertificateField =
  | { name: string; type: 'text' | 'date' | 'time' | 'lines'; required: boolean }
  | { name: string; type: 'select'; required: boolean; options: readonly string[] };

export const CERTIFICATE_FIELDS: Record<CertificateKind, readonly CertificateField[]> = {
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
        .refine((value) => field.options.includes(value), 'validation.invalid_format');
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
export function certificateFormSchema(kind: CertificateKind) {
  const shape: Record<string, z.ZodType<string, string>> = {};
  for (const field of CERTIFICATE_FIELDS[kind]) shape[field.name] = fieldSchema(field);
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

export function emptyCertificate(kind: CertificateKind, today: string): CertificateValues {
  return {
    issuedOn: today,
    fields: Object.fromEntries(CERTIFICATE_FIELDS[kind].map((field) => [field.name, ''])),
  };
}
