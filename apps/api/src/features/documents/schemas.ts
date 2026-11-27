import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 900;
export const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_CATEGORIES = [
  'consent',
  'referral_letter',
  'outside_report',
  'id_proof',
  'insurance',
  'certificate',
  'opd_sheet',
  'other',
] as const;
export const DOCUMENT_STATUSES = [
  'pending',
  'scanning',
  'clean',
  'infected',
  'failed',
  'purged',
] as const;

const Category = StringEnum(DOCUMENT_CATEGORIES);
const Id = Type.String({ format: 'uuid' });

export const PatientDocument = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    encounterId: Type.Optional(Type.String()),
    category: Category,
    title: Type.String(),
    fileName: Type.String(),
    contentType: Type.String(),
    size: Type.Integer(),
    status: StringEnum(DOCUMENT_STATUSES, {
      description:
        'pending: nothing received yet. scanning: waiting for the malware scan. clean: may be downloaded. infected: blocked and deleted. failed: lost or could not be scanned. purged: past its retention, the file removed.',
    }),
    retainUntil: Type.Optional(
      Type.String({ format: 'date', description: 'Absent when the category is kept for ever.' }),
    ),
    retiredAt: Type.Optional(Type.String({ format: 'date-time' })),
    retiredReason: Type.Optional(Type.String()),
    held: Type.Boolean({
      description:
        'True while an active legal hold covers the document, on it or on every document of the patient (#672).',
    }),
    version: Type.Integer(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PatientDocument', description: 'A file kept on a patient’s record.' },
);
export type PatientDocument = Static<typeof PatientDocument>;

export const PatientDocumentCreate = Type.Object(
  {
    category: Category,
    title: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    fileName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    contentType: Type.String({
      description: `One of ${DOCUMENT_TYPES.join(', ')} (422 \`file_type_not_allowed\`).`,
    }),
    size: Type.Integer({
      minimum: 1,
      description: `Bytes, at most ${DOCUMENT_MAX_BYTES} (422 \`file_too_large\`).`,
    }),
    encounterId: Type.Optional(Id),
  },
  { $id: 'PatientDocumentCreate', additionalProperties: false },
);
export type PatientDocumentCreate = Static<typeof PatientDocumentCreate>;

export const PatientDocumentUpload = Type.Object(
  {
    document: ref(PatientDocument),
    uploadUrl: Type.String({
      description: 'A signed, short-lived address to PUT the file to with the same Content-Type.',
    }),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PatientDocumentUpload' },
);

export const PatientDocumentPage = CursorPage(ref(PatientDocument), { $id: 'PatientDocumentPage' });

export const PatientDocumentDownload = Type.Object(
  { url: Type.String(), expiresAt: Type.String({ format: 'date-time' }) },
  { $id: 'PatientDocumentDownload' },
);

export const PatientDocumentRetire = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    expectedVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: 'PatientDocumentRetire', additionalProperties: false },
);
export type PatientDocumentRetire = Static<typeof PatientDocumentRetire>;

const SheetStatus = Type.Union(
  ['pending', 'scanning', 'clean', 'infected', 'failed', 'purged'].map((value) =>
    Type.Literal(value as 'pending' | 'scanning' | 'clean' | 'infected' | 'failed' | 'purged'),
  ),
);

export const PaperVisit = Type.Object(
  {
    patientId: Id,
    patientName: Type.String(),
    patientMrn: Type.String(),
    tokenNumber: Type.Optional(
      Type.Integer({ description: 'Of the queue token the visit is, or would be, opened from.' }),
    ),
    doctorName: Type.Optional(Type.String()),
    encounter: Type.Optional(
      Type.Object(
        {
          id: Id,
          status: Type.Union([
            Type.Literal('open'),
            Type.Literal('closed'),
            Type.Literal('cancelled'),
          ]),
          openedAt: Type.String({ format: 'date-time' }),
          version: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    hasSheet: Type.Boolean({
      description:
        'Whether an OPD sheet that is clean or being scanned, and not retired, is on the visit, whoever attached it: the visit may then be closed from here.',
    }),
    sheets: Type.Array(
      Type.Object(
        {
          id: Id,
          fileName: Type.String(),
          status: SheetStatus,
          createdAt: Type.String({ format: 'date-time' }),
          version: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      {
        description:
          'The sheets the caller attached to this visit and has not retired, newest first, at most 20: never anyone else’s, and no way to open them.',
      },
    ),
  },
  { $id: 'PaperVisit', additionalProperties: false },
);
export type PaperVisit = Static<typeof PaperVisit>;

export const PaperTokenParams = Type.Object({ tokenId: Id });
export const PaperEncounterParams = Type.Object({ encounterId: Id });
export const PaperSheetParams = Type.Object({ encounterId: Id, documentId: Id });
export const PaperVisitClose = Type.Object(
  { version: Type.Integer({ minimum: 1, description: 'Of the visit, as last read.' }) },
  { $id: 'PaperVisitClose', additionalProperties: false },
);
export type PaperVisitClose = Static<typeof PaperVisitClose>;

export const DocumentListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  category: Type.Optional(Category),
  encounterId: Type.Optional(Id),
  includeRetired: Type.Optional(
    Type.Boolean({ description: 'Retired documents are left out unless asked for.' }),
  ),
});
export type DocumentListQuery = Static<typeof DocumentListQuery>;

export const RetentionRule = Type.Object(
  {
    category: Category,
    years: Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()], {
      description: 'Years a document of the category is kept; null keeps it for ever.',
    }),
    otherRuleCount: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Only in the list: documents of the category not yet purged whose retention date is not the one the rule would give today, kept under an earlier rule (#674).',
      }),
    ),
  },
  { $id: 'DocumentRetentionRule' },
);
export const RetentionRules = Type.Object(
  { items: Type.Array(ref(RetentionRule)) },
  { $id: 'DocumentRetentionRules' },
);
export const RetentionRuleSet = Type.Object(
  {
    // Years or null (keep for ever), as one schema with both types: see core/http/strict-body.
    years: Type.Unsafe<number | null>({ type: ['integer', 'null'], minimum: 1, maximum: 100 }),
  },
  { $id: 'DocumentRetentionRuleSet', additionalProperties: false },
);
export type RetentionRuleSet = Static<typeof RetentionRuleSet>;

export const LegalHold = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    documentId: Type.Optional(
      Type.String({ description: 'Absent: the hold covers every document of the patient.' }),
    ),
    reason: Type.String(),
    placedAt: Type.String({ format: 'date-time' }),
    releasedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { $id: 'DocumentLegalHold', description: 'A hold that stops the retention sweep purging files.' },
);
export const LegalHoldPage = CursorPage(ref(LegalHold), { $id: 'DocumentLegalHoldPage' });
export const LegalHoldCreate = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }) },
  { $id: 'DocumentLegalHoldCreate', additionalProperties: false },
);
export type LegalHoldCreate = Static<typeof LegalHoldCreate>;
export const HoldParams = Type.Object({ holdId: Id });
export const HoldListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
});

export const PatientParams = Type.Object({ patientId: Id });
export const DocumentParams = Type.Object({ documentId: Id });
export const CategoryParams = Type.Object({ category: Category });
export const SignedQuery = Type.Object({
  expires: Type.Integer({ minimum: 0 }),
  signature: Type.String({ minLength: 1, maxLength: 200 }),
});

export const BlockedDocument = Type.Object(
  {
    id: Id,
    title: Type.String(),
    fileName: Type.String(),
    status: StringEnum(['infected', 'failed']),
    blockedAt: Type.String({ format: 'date-time' }),
  },
  {
    $id: 'BlockedDocument',
    description: 'A file the caller attached that the scan blocked, not yet dismissed.',
  },
);
export const BlockedDocuments = Type.Object(
  { items: Type.Array(ref(BlockedDocument)) },
  { $id: 'BlockedDocuments' },
);

export const DOCUMENT_SCHEMAS = [
  BlockedDocument,
  BlockedDocuments,
  PatientDocument,
  PatientDocumentCreate,
  PatientDocumentUpload,
  PatientDocumentPage,
  PatientDocumentDownload,
  PatientDocumentRetire,
  PaperVisit,
  PaperVisitClose,
  RetentionRule,
  RetentionRules,
  RetentionRuleSet,
  LegalHold,
  LegalHoldPage,
  LegalHoldCreate,
] as const;
