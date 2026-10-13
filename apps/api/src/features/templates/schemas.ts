import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { TEMPLATE_KINDS } from './placeholders.js';

export const NAME_MAX = 100;
/** A template has at most this many versions: every answer lists them all. */
export const VERSIONS_MAX = 500;

/**
 * Why a version was redacted. From a list, so that the reason cannot itself hold what was
 * removed.
 */
export const REDACTION_REASONS = [
  'patient_data',
  'personal_data',
  'confidential',
  'other',
] as const;
export type RedactionReason = (typeof REDACTION_REASONS)[number];

const kind = StringEnum(TEMPLATE_KINDS);

const BODY =
  'The text of a template: the rich text document of the app (paragraphs, headings, lists, quotes and marks), never HTML. Reduced to that allowlist on the way in. Placeholders are plain text in double braces, `{{patient.name}}`. A placeholder is recognised only inside one run of text, for the check and for filling alike: one that is split by formatting (half of it bold) is neither checked nor ever filled, by any part of the system. Names are trimmed and case-sensitive. A value is filled in as text and is never read for placeholders again.';
const body = Type.Unsafe<Record<string, unknown>>({
  type: 'object',
  description: BODY,
  additionalProperties: true,
});

export const Template = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    kind,
    name: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    savedAt: Type.String({ format: 'date-time' }),
    archived: Type.Boolean(),
  },
  { $id: 'Template', description: 'A document template of a hospital. Holds no patient data.' },
);
export type Template = Static<typeof Template>;

export const TemplatePage = CursorPage(ref(Template), { $id: 'TemplatePage' });

const versionInfo = {
  version: Type.Integer({ minimum: 1 }),
  savedAt: Type.String({ format: 'date-time' }),
  savedByName: Type.String({ description: 'The member of staff who saved it.' }),
  redactedAt: Type.Optional(
    Type.String({
      format: 'date-time',
      description: 'When the name and the text of this version were removed. Absent otherwise.',
    }),
  ),
};

export const TemplateVersionInfo = Type.Object(versionInfo, { $id: 'TemplateVersionInfo' });
export type TemplateVersionInfo = Static<typeof TemplateVersionInfo>;

export const TemplateVersion = Type.Object(
  {
    ...versionInfo,
    name: Type.String({ description: 'Empty for a redacted version.' }),
    body,
    redactedByName: Type.Optional(
      Type.String({ description: 'The member of staff who redacted it.' }),
    ),
    redactionReason: Type.Optional(StringEnum(REDACTION_REASONS)),
  },
  {
    $id: 'TemplateVersion',
    description:
      'One version of a template, as it was saved. A redacted version has an empty name and an empty text, and says when, by whom and why.',
  },
);
export type TemplateVersion = Static<typeof TemplateVersion>;

export const TemplateDetail = Type.Object(
  {
    template: ref(Template),
    body,
    versions: Type.Array(ref(TemplateVersionInfo), {
      description: 'Every version, the newest first.',
    }),
  },
  { $id: 'TemplateDetail' },
);
export type TemplateDetail = Static<typeof TemplateDetail>;

const name = Type.String({ minLength: 1, maxLength: NAME_MAX, pattern: PLAIN_TEXT });

export const TemplateCreate = Type.Object(
  { kind, name, body },
  { $id: 'TemplateCreate', additionalProperties: false },
);
export type TemplateCreate = Static<typeof TemplateCreate>;

export const TemplateSave = Type.Object(
  { name: Type.Optional(name), body: Type.Optional(body), expectedVersion: Type.Integer() },
  { $id: 'TemplateSave', additionalProperties: false },
);
export type TemplateSave = Static<typeof TemplateSave>;

export const TemplateRedact = Type.Object(
  {
    reason: StringEnum(REDACTION_REASONS, {
      description:
        'Why the version is removed, from a list: free text here could repeat what is being removed.',
    }),
  },
  { $id: 'TemplateRedact', additionalProperties: false },
);
export type TemplateRedact = Static<typeof TemplateRedact>;

/** Every parameter may be left out: a client asks for the first page of the templates in use. */
export const TemplateListQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
  kind: Type.Optional(kind),
  archived: Type.Optional(
    Type.Boolean({
      default: false,
      description: 'True lists the archived templates instead of the ones in use.',
    }),
  ),
});

export const TEMPLATE_SCHEMAS = [
  Template,
  TemplatePage,
  TemplateVersionInfo,
  TemplateVersion,
  TemplateDetail,
  TemplateCreate,
  TemplateSave,
  TemplateRedact,
];
