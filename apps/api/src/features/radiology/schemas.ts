import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { OrderPriority, OrderStatus } from '../clinical/index.js';
import { MODALITIES } from '../services/index.js';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
const named = <const Values extends readonly string[]>(
  $id: string,
  values: Values,
  description?: string,
) =>
  Type.Unsafe<Values[number]>({
    $id,
    type: 'string',
    enum: [...values],
    ...(description ? { description } : {}),
  });

export const STAGES = ['to_schedule', 'scheduled', 'performed', 'reported'] as const;
export type ImagingStageValue = (typeof STAGES)[number];
export const ImagingStage = named(
  'ImagingStage',
  STAGES,
  'Where an imaging order is in radiology: ordered and still to schedule (never scheduled, or unscheduled), scheduled for a slot, performed and waiting for its report to be signed, or reported (its report signed and the order completed).',
);

export type ImagingModalityValue = (typeof MODALITIES)[number];
export const ImagingModality = named(
  'ImagingModality',
  MODALITIES,
  'The equipment a study is performed on, from its imaging service; `other` when the service has none.',
);

/** How far ahead a study is scheduled, in days. */
export const SCHEDULE_DAYS_AHEAD = 90;
/** The length of a slot, in minutes: a study starts on one. */
export const SLOT_MINUTES = 15;

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});

export const ImagingStudy = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    orderId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    modality: ref(ImagingModality),
    scheduledAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'The start of its slot. Absent once unscheduled, until scheduled again.',
      }),
    ),
    scheduledByName: Type.Optional(Type.String()),
    performedAt: Type.Optional(Type.String({ format: 'date-time' })),
    performedByName: Type.Optional(Type.String()),
    version: Type.Integer(),
  },
  {
    $id: 'ImagingStudy',
    description:
      'The study of one imaging order: scheduled, then performed. Never removed; once performed, never changed.',
  },
);
export type ImagingStudy = Static<typeof ImagingStudy>;

export const REPORT_STATUSES = ['draft', 'signed'] as const;
export const ImagingReportStatus = named(
  'ImagingReportStatus',
  REPORT_STATUSES,
  'A report is a draft, kept on the server, until a radiologist signs it; a signed report never changes.',
);

export const ADDENDUM_REASONS = [
  'correction',
  'additional_finding',
  'clarification',
  'comparison',
  'other',
] as const;
export type AddendumReason = (typeof ADDENDUM_REASONS)[number];

/** At most this many links to images held elsewhere. */
export const MAX_LINKS = 10;
export const LINK_LABEL_MAX = 120;
export const LINK_URL_MAX = 2000;

const RichText = (description: string) =>
  Type.Unsafe<Record<string, unknown>>({
    type: 'object',
    additionalProperties: true,
    description: `${description} The rich text document of the app (paragraphs, headings, lists, quotes and marks), never HTML, reduced to that allowlist on the way in.`,
  });

export const ImagingLink = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: LINK_LABEL_MAX, pattern: PLAIN_TEXT }),
    url: Type.String({
      minLength: 9,
      maxLength: LINK_URL_MAX,
      pattern: '^https://',
      description:
        'An https address of the images held elsewhere (a viewer, another hospital), with no user name or password and no parameter named as a secret (token, signature, key, session and the like) in it (400 `invalid_link`). No DICOM viewer in this release.',
    }),
  },
  {
    $id: 'ImagingLink',
    additionalProperties: false,
    description: 'A link to images of the study held outside the system.',
  },
);
export type ImagingLink = Static<typeof ImagingLink>;

export const ImagingAddendum = Type.Object(
  {
    id: Type.String(),
    body: RichText('What is added.'),
    reason: StringEnum(ADDENDUM_REASONS),
    signedByName: Type.String(),
    signedAt: Type.String({ format: 'date-time' }),
  },
  {
    $id: 'ImagingAddendum',
    description: 'Text added to a signed report, signed by its author. Never changed or removed.',
  },
);
export type ImagingAddendum = Static<typeof ImagingAddendum>;

export const ImagingReport = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    orderId: Type.String(),
    studyId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    status: ref(ImagingReportStatus),
    technique: RichText('How the study was done. May be empty.'),
    findings: RichText('What was seen.'),
    impression: RichText('The conclusion.'),
    links: Type.Array(ref(ImagingLink)),
    templateId: Type.Optional(Type.String()),
    templateVersion: Type.Optional(Type.Integer()),
    createdByName: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    updatedByName: Type.String(),
    updatedAt: Type.String({ format: 'date-time' }),
    signedByName: Type.Optional(Type.String()),
    signedAt: Type.Optional(Type.String({ format: 'date-time' })),
    addenda: Type.Array(ref(ImagingAddendum), { description: 'The oldest first.' }),
    version: Type.Integer(),
  },
  {
    $id: 'ImagingReport',
    description:
      'The report of a performed imaging study: a draft until signed, then never changed; corrections are addenda.',
  },
);
export type ImagingReport = Static<typeof ImagingReport>;

export const ImagingReportDraft = Type.Object(
  {
    technique: RichText('How the study was done. May be empty.'),
    findings: RichText('What was seen. May be empty in a draft.'),
    impression: RichText('The conclusion. May be empty in a draft.'),
    links: Type.Array(ref(ImagingLink), {
      maxItems: MAX_LINKS,
      description: 'Every link the report has: the list replaces the saved one.',
    }),
    templateId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The imaging report template the text was filled from, sent with its version (422 `template_not_found` when it is no such template and version). Left out, the report names none.',
      }),
    ),
    templateVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    version: Type.Optional(
      Type.Integer({
        description:
          'The version of the report the change was made from, required once the study has one (409 `conflict` when it is missing or another).',
      }),
    ),
  },
  { $id: 'ImagingReportDraft', additionalProperties: false },
);
export type ImagingReportDraft = Static<typeof ImagingReportDraft>;

export const ImagingReportSign = Type.Object(
  { version: Version },
  { $id: 'ImagingReportSign', additionalProperties: false },
);
export type ImagingReportSign = Static<typeof ImagingReportSign>;

export const ImagingAddendumCreate = Type.Object(
  {
    body: RichText('What is added, never empty.'),
    reason: StringEnum(ADDENDUM_REASONS, { description: 'Why it is added, from a list.' }),
  },
  { $id: 'ImagingAddendumCreate', additionalProperties: false },
);
export type ImagingAddendumCreate = Static<typeof ImagingAddendumCreate>;

export const ImagingWorkItem = Type.Object(
  {
    orderId: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    patientSex: Type.String({
      description: 'The patient’s gender as registered, to fill a report template.',
    }),
    patientDob: Type.Optional(
      Type.String({
        format: 'date',
        description: 'A calendar date, to tell the patient apart before the study.',
      }),
    ),
    serviceId: Type.String(),
    itemCode: Type.Optional(Type.String()),
    itemName: Type.String(),
    modality: ref(ImagingModality),
    priority: ref(OrderPriority),
    instructions: Type.Optional(Type.String()),
    placedAt: Type.String({ format: 'date-time' }),
    orderedByName: Type.String(),
    orderStatus: ref(OrderStatus),
    stage: ref(ImagingStage),
    study: Type.Optional(ref(ImagingStudy)),
    reportStatus: Type.Optional(ref(ImagingReportStatus)),
    reportSignedAt: Type.Optional(Type.String({ format: 'date-time' })),
    reportSignedByName: Type.Optional(Type.String()),
  },
  {
    $id: 'ImagingWorkItem',
    description: 'An imaging order as radiology works it, with its study once it has one.',
  },
);
export type ImagingWorkItem = Static<typeof ImagingWorkItem>;

export const ImagingWorkItemPage = CursorPage(ref(ImagingWorkItem), {
  $id: 'ImagingWorkItemPage',
});

export const WorklistQuery = Type.Object({
  stage: Type.Optional(ref(ImagingStage)),
  modality: Type.Optional(ref(ImagingModality)),
  priority: Type.Optional(ref(OrderPriority)),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});
export type WorklistQuery = Static<typeof WorklistQuery>;

export const OrderParams = Type.Object({ orderId: Id });

export const ImagingSchedule = Type.Object(
  {
    scheduledAt: Type.String({
      format: 'date-time',
      description: `The start of the slot: on a ${SLOT_MINUTES}-minute step (422 \`invalid_slot\`), from the current step to the end of the ${SCHEDULE_DAYS_AHEAD}th day ahead at the hospital (422 \`outside_window\`).`,
    }),
    version: Type.Optional(
      Type.Integer({
        description:
          'The version of the study the change was made from, required once the order has one (409 `conflict` when it is missing or another).',
      }),
    ),
  },
  { $id: 'ImagingSchedule', additionalProperties: false },
);
export type ImagingSchedule = Static<typeof ImagingSchedule>;

export const ImagingStudyChange = Type.Object(
  { version: Version },
  { $id: 'ImagingStudyChange', additionalProperties: false },
);
export type ImagingStudyChange = Static<typeof ImagingStudyChange>;

export const RADIOLOGY_SCHEMAS = [
  OrderPriority,
  OrderStatus,
  ImagingStage,
  ImagingModality,
  ImagingStudy,
  ImagingReportStatus,
  ImagingLink,
  ImagingAddendum,
  ImagingReport,
  ImagingReportDraft,
  ImagingReportSign,
  ImagingAddendumCreate,
  ImagingWorkItem,
  ImagingWorkItemPage,
  ImagingSchedule,
  ImagingStudyChange,
];
