import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, CursorQuery, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

const nullableString = (options: Record<string, unknown> = {}) =>
  Type.Unsafe<string | null>({ type: ['string', 'null'], ...options });
const nullableInteger = (options: Record<string, unknown> = {}) =>
  Type.Unsafe<number | null>({ type: ['integer', 'null'], ...options });

const SLUG = '^[a-z0-9]+(-[a-z0-9]+)*$';
const HEX_COLOUR = '^#[0-9a-fA-F]{6}$';
const HTTPS_URL = '^https://[^\\s]+$';
const REGION = '^[a-z][a-z0-9-]*$';

export const HOSPITAL_STATUSES = ['active', 'suspended', 'offboarding', 'deleted'] as const;

export const PlatformHospital = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    slug: Type.String(),
    name: Type.String(),
    locale: Type.String(),
    timezone: Type.String(),
    currency: Type.String(),
    themePrimary: Type.String(),
    themeLogoUrl: nullableString(),
    address: nullableString(),
    phone: nullableString(),
    registrationNumber: nullableString(),
    authMode: StringEnum(['password', 'sso']),
    region: nullableString(),
    status: StringEnum(HOSPITAL_STATUSES),
    maxUsers: nullableInteger({ description: 'Null: no limit.' }),
    storageMb: nullableInteger({ description: 'Null: no limit.' }),
    version: Type.Integer({
      description: 'Moves with every edit. Send it back to edit, so a stale form is refused (409).',
    }),
    memberCount: Type.Integer({ description: 'Active staff accounts at the hospital.' }),
    features: Type.Array(Type.Object({ feature: Type.String(), enabled: Type.Boolean() }), {
      description: 'Every module flag set for the hospital. A module not listed is off.',
    }),
    createdAt: Type.String({ format: 'date-time' }),
    suspendedAt: nullableString(),
    offboardingRequestedAt: nullableString(),
    deleteAfter: nullableString({
      description: 'When the hospital’s data may be deleted. Nothing deletes it yet.',
    }),
  },
  { $id: 'PlatformHospital' },
);
export type PlatformHospital = Static<typeof PlatformHospital>;

export const PlatformHospitalPage = CursorPage(ref(PlatformHospital), {
  $id: 'PlatformHospitalPage',
});

const name = Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT });
const locale = Type.String({
  minLength: 2,
  maxLength: 35,
  description: 'A BCP 47 tag, e.g. en-IN.',
});
const timezone = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'An IANA zone, e.g. Asia/Kolkata.',
});
const currency = Type.String({ pattern: '^[A-Z]{3}$', description: 'ISO 4217, e.g. INR.' });
const themePrimary = Type.String({ pattern: HEX_COLOUR });
const authMode = StringEnum(['password', 'sso']);

const details = {
  themeLogoUrl: nullableString({ maxLength: 2048, pattern: HTTPS_URL }),
  address: nullableString({ maxLength: 500, pattern: PLAIN_TEXT }),
  phone: nullableString({ maxLength: 32, pattern: PLAIN_TEXT }),
  registrationNumber: nullableString({ maxLength: 100, pattern: PLAIN_TEXT }),
  region: nullableString({ maxLength: 31, pattern: REGION }),
  maxUsers: nullableInteger({ minimum: 1, maximum: 1_000_000 }),
  storageMb: nullableInteger({ minimum: 1, maximum: 100_000_000 }),
};

export const CreateHospitalBody = Type.Object({
  slug: Type.String({
    minLength: 1,
    maxLength: 63,
    pattern: SLUG,
    description: 'Stable and URL-safe. Not used to find the hospital: that comes from the session.',
  }),
  name,
  locale,
  timezone,
  currency,
  themePrimary,
  authMode: Type.Optional(StringEnum(['password', 'sso'], { description: 'Absent: password.' })),
  themeLogoUrl: Type.Optional(details.themeLogoUrl),
  address: Type.Optional(details.address),
  phone: Type.Optional(details.phone),
  registrationNumber: Type.Optional(details.registrationNumber),
  region: Type.Optional(details.region),
  maxUsers: Type.Optional(details.maxUsers),
  storageMb: Type.Optional(details.storageMb),
  features: Type.Array(Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z][a-z0-9_]*$' }), {
    maxItems: 200,
    description: 'The modules switched on at the start. Unknown modules are refused.',
  }),
});
export type CreateHospitalBody = Static<typeof CreateHospitalBody>;

export const UpdateHospitalBody = Type.Object({
  version: Type.Integer({ minimum: 1, description: 'The version the edit started from.' }),
  name: Type.Optional(name),
  locale: Type.Optional(locale),
  timezone: Type.Optional(timezone),
  currency: Type.Optional(currency),
  themePrimary: Type.Optional(themePrimary),
  authMode: Type.Optional(authMode),
  themeLogoUrl: Type.Optional(details.themeLogoUrl),
  address: Type.Optional(details.address),
  phone: Type.Optional(details.phone),
  registrationNumber: Type.Optional(details.registrationNumber),
  region: Type.Optional(details.region),
  maxUsers: Type.Optional(details.maxUsers),
  storageMb: Type.Optional(details.storageMb),
});
export type UpdateHospitalBody = Static<typeof UpdateHospitalBody>;

export const SetFeaturesBody = Type.Object({
  features: Type.Array(
    Type.Object({
      feature: Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z][a-z0-9_]*$' }),
      enabled: Type.Boolean(),
    }),
    { minItems: 1, maxItems: 200 },
  ),
});
export type SetFeaturesBody = Static<typeof SetFeaturesBody>;

export const ListHospitalsQuery = Type.Object({
  ...CursorQuery.properties,
  status: Type.Optional(StringEnum(HOSPITAL_STATUSES)),
  q: Type.Optional(Type.String({ maxLength: 100, description: 'Part of a name or slug.' })),
});
export type ListHospitalsQuery = Static<typeof ListHospitalsQuery>;

export const HospitalParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const AdminInviteBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
  email: Type.String({ minLength: 3, maxLength: 254 }),
});

export const PlatformInvite = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    email: Type.String(),
    name: Type.String(),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PlatformInvite' },
);
export type PlatformInvite = Static<typeof PlatformInvite>;

export const PlatformInvitePage = CursorPage(ref(PlatformInvite), { $id: 'PlatformInvitePage' });

export const InviteParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  inviteId: Type.String({ format: 'uuid' }),
});

export const DEFAULT_DELETE_AFTER_DAYS = 90;

export const OffboardBody = Type.Object({
  deleteAfterDays: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 3650,
      description: `Days from now until the hospital’s data may be deleted, after its export. Defaults to ${DEFAULT_DELETE_AFTER_DAYS} (docs/OPEN_DECISIONS.md).`,
    }),
  ),
});

export const PlatformAuditEntry = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    at: Type.String({ format: 'date-time' }),
    actorId: Type.String({ format: 'uuid' }),
    action: Type.String(),
    entity: Type.String(),
    entityId: nullableString(),
    hospitalId: nullableString(),
    detail: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      { description: 'Ids and codes only, e.g. which module was switched.' },
    ),
  },
  { $id: 'PlatformAuditEntry' },
);
export type PlatformAuditEntry = Static<typeof PlatformAuditEntry>;

export const PlatformAuditPage = CursorPage(ref(PlatformAuditEntry), { $id: 'PlatformAuditPage' });

export const AuditQuery = Type.Object({
  ...CursorQuery.properties,
  hospitalId: Type.Optional(Type.String({ format: 'uuid' })),
  actorId: Type.Optional(Type.String({ format: 'uuid' })),
});
export type AuditQuery = Static<typeof AuditQuery>;

export const PlatformModule = Type.Object(
  {
    id: Type.String({ description: 'The id `PUT .../features` and the create route accept.' }),
    kind: StringEnum(['module', 'switch'], {
      description:
        '`module`: a feature a hospital can be given. `switch`: the authenticator’s `mfa` or `mfa_required`, which are not modules.',
    }),
  },
  { $id: 'PlatformModule' },
);
export type PlatformModule = Static<typeof PlatformModule>;

export const PlatformModuleList = Type.Object(
  { items: Type.Array(ref(PlatformModule)) },
  { $id: 'PlatformModuleList' },
);

export const PlatformExport = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    hospitalId: Type.String({ format: 'uuid' }),
    status: StringEnum(['queued', 'running', 'succeeded', 'failed']),
    failure: nullableString({ description: 'A code: too_large, not_offboarding or failed.' }),
    requestedAt: Type.String({ format: 'date-time' }),
    finishedAt: nullableString({ format: 'date-time' }),
    fileBytes: nullableInteger(),
    sha256: nullableString({ description: 'Checksum of the whole archive.' }),
    tableCount: nullableInteger(),
    rowCount: nullableInteger(),
    fileCount: nullableInteger(),
    downloadCount: Type.Integer(),
    firstDownloadedAt: nullableString({ format: 'date-time' }),
    lastDownloadedAt: nullableString({ format: 'date-time' }),
  },
  { $id: 'PlatformExport' },
);
export type PlatformExport = Static<typeof PlatformExport>;

export const PlatformExportList = Type.Object(
  { items: Type.Array(ref(PlatformExport)) },
  { $id: 'PlatformExportList' },
);

export const ExportParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  exportId: Type.String({ format: 'uuid' }),
});

export const ExportLinkBody = Type.Object({
  adminUserId: Type.String({
    format: 'uuid',
    description:
      'An active admin of the hospital: the link is made for that person and audited under them.',
  }),
});

export const ExportLinkSent = Type.Object(
  {
    adminUserId: Type.String({ format: 'uuid' }),
    expiresInDays: Type.Integer(),
  },
  {
    $id: 'ExportLinkSent',
    description: 'The link is queued to that admin by email; it is not returned.',
  },
);

export const ExportDownloadParams = Type.Object({ exportId: Type.String({ format: 'uuid' }) });
export const ExportDownloadQuery = Type.Object({
  admin: Type.String({ format: 'uuid' }),
  expires: Type.Integer({ minimum: 0 }),
  signature: Type.String({ minLength: 20, maxLength: 128 }),
});

export const PlatformDeletion = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    hospitalId: Type.String({ format: 'uuid' }),
    status: StringEnum(['requested', 'approved', 'running', 'done', 'failed', 'cancelled']),
    basis: StringEnum(['export', 'waiver'], {
      description: 'What allows it: a downloaded export of the hospital, or its signed waiver.',
    }),
    exportId: nullableString({ format: 'uuid' }),
    waiverReference: nullableString(),
    requestedBy: Type.String({ format: 'uuid' }),
    requestedAt: Type.String({ format: 'date-time' }),
    approvedBy: nullableString({ format: 'uuid' }),
    approvedAt: nullableString({ format: 'date-time' }),
    finishedAt: nullableString({ format: 'date-time' }),
    failure: nullableString({
      description:
        'A code: a reason it was blocked when it ran (legal_hold, medico_legal_open, ...), verification_failed or failed.',
    }),
    tableCount: nullableInteger(),
    rowCount: nullableInteger(),
    fileCount: nullableInteger(),
  },
  { $id: 'PlatformDeletion' },
);
export type PlatformDeletion = Static<typeof PlatformDeletion>;

export const DeletionRequestBody = Type.Object(
  {
    waiverReference: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        pattern: PLAIN_TEXT,
        description:
          'Where the hospital’s signed waiver is kept (a document number). Give it when there is no downloaded export; the waiver itself is never stored here.',
      }),
    ),
  },
  { additionalProperties: false },
);

export const PLATFORM_SCHEMAS = [
  PlatformDeletion,
  PlatformExport,
  PlatformExportList,
  ExportLinkSent,
  PlatformModule,
  PlatformModuleList,
  PlatformHospital,
  PlatformHospitalPage,
  PlatformInvite,
  PlatformInvitePage,
  PlatformAuditEntry,
  PlatformAuditPage,
] as const;
