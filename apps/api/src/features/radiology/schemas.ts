import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
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

export const STAGES = ['to_schedule', 'scheduled', 'performed'] as const;
export type ImagingStageValue = (typeof STAGES)[number];
export const ImagingStage = named(
  'ImagingStage',
  STAGES,
  'Where an imaging order is in radiology: ordered and still to schedule (never scheduled, or unscheduled), scheduled for a slot, or performed and waiting for its report.',
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

export const ImagingWorkItem = Type.Object(
  {
    orderId: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
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
  ImagingWorkItem,
  ImagingWorkItemPage,
  ImagingSchedule,
  ImagingStudyChange,
];
