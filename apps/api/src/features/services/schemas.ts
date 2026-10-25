import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

export const CODE_MAX = 30;
export const NAME_MAX = 150;
export const DESCRIPTION_MAX = 500;
/** The largest amount a price can be, in minor units. */
export const AMOUNT_MAX = 1_000_000_000_000;

export const SERVICE_CATEGORIES = [
  'consultation',
  'procedure',
  'bed',
  'lab',
  'imaging',
  'package',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** The kind of equipment an imaging service is performed on (#96). Only imaging services have one. */
export const MODALITIES = [
  'xray',
  'ct',
  'mri',
  'ultrasound',
  'mammography',
  'fluoroscopy',
  'nuclear',
  'other',
] as const;
export type Modality = (typeof MODALITIES)[number];

export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;
export type TaxClass = (typeof TAX_CLASSES)[number];

const Category = StringEnum(SERVICE_CATEGORIES);
const TaxClassSchema = StringEnum(TAX_CLASSES, {
  description:
    "Which tax rate applies, as a class. The rate of each class is the hospital's tax setting, so a change of rate does not touch the services.",
});
const ModalitySchema = StringEnum(MODALITIES, {
  description:
    'The equipment an imaging service is performed on, which sorts radiology’s worklist. Only a service of the category imaging has one.',
});
/** A modality or null, in a request: one schema with both types, never a union. */
const NullableModality = Type.Unsafe<Modality | null>({
  type: ['string', 'null'],
  enum: [...MODALITIES, null],
  description: 'Null removes the modality. Only a service of the category imaging has one.',
});
const Amount = Type.Integer({
  minimum: 0,
  maximum: AMOUNT_MAX,
  description: "In the minor unit of the hospital's currency.",
});
const CalendarDate = Type.String({
  format: 'date',
  description: 'A calendar date at the hospital.',
});

export const ServicePrice = Type.Object(
  {
    id: Type.String(),
    serviceId: Type.String(),
    priceListId: Type.String(),
    amountMinor: Amount,
    effectiveFrom: CalendarDate,
    effectiveTo: Type.Optional(
      Type.String({
        format: 'date',
        description: 'The last day it applies. Absent while no later price follows.',
      }),
    ),
  },
  {
    $id: 'ServicePrice',
    description:
      'What a service costs on one price list from one date. A price is never edited: a new one takes over from its own date.',
  },
);
export type ServicePrice = Static<typeof ServicePrice>;

export const ServicePricePage = CursorPage(ref(ServicePrice), { $id: 'ServicePricePage' });

export const Service = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    code: Type.String({ description: "The service's identity on bills. Never changes." }),
    name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
    category: Category,
    taxClass: TaxClassSchema,
    modality: Type.Optional(ModalitySchema),
    description: Type.Optional(Type.String({ maxLength: DESCRIPTION_MAX })),
    archived: Type.Boolean(),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
    currentPrice: Type.Optional(ref(ServicePrice)),
  },
  {
    $id: 'Service',
    description:
      'Something the hospital can charge for. Holds no patient data. Its name, category and tax class can be changed, and a charge keeps what they were when it was posted: changing them never changes an old bill. `currentPrice` is the price in force today on the standard list, absent when there is none.',
  },
);
export type Service = Static<typeof Service>;

export const ServicePage = CursorPage(ref(Service), { $id: 'ServicePage' });

const name = Type.String({ minLength: 1, maxLength: NAME_MAX, pattern: PLAIN_TEXT });
const description = Type.String({ maxLength: DESCRIPTION_MAX, pattern: PLAIN_LINES });

export const ServiceCreate = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: CODE_MAX,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    }),
    name,
    category: Category,
    taxClass: TaxClassSchema,
    modality: Type.Optional(ModalitySchema),
    description: Type.Optional(description),
    priceMinor: Type.Optional(Amount),
  },
  { $id: 'ServiceCreate', additionalProperties: false },
);
export type ServiceCreate = Static<typeof ServiceCreate>;

export const ServiceUpdate = Type.Object(
  {
    name: Type.Optional(name),
    category: Type.Optional(Category),
    taxClass: Type.Optional(TaxClassSchema),
    modality: Type.Optional(NullableModality),
    description: Type.Optional(description),
    expectedVersion: Type.Integer(),
  },
  { $id: 'ServiceUpdate', additionalProperties: false },
);
export type ServiceUpdate = Static<typeof ServiceUpdate>;

/** In the body, never the query string: see Searches in the root CLAUDE.md. */
export const ServiceSearchRequest = Type.Object(
  {
    cursor: Type.Optional(
      Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
    ),
    // No default value on the fields of a body: the generated client would make them required.
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'Absent: 25.' }),
    ),
    q: Type.Optional(Type.String({ maxLength: 100 })),
    category: Type.Optional(Category),
    archived: Type.Optional(
      Type.Boolean({
        description: 'True lists the archived services instead of the active ones. Absent: false.',
      }),
    ),
  },
  { $id: 'ServiceSearchRequest', additionalProperties: false },
);
export type ServiceSearchRequest = Static<typeof ServiceSearchRequest>;

export const ServicePriceCreate = Type.Object(
  {
    amountMinor: Amount,
    effectiveFrom: CalendarDate,
    priceListId: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { $id: 'ServicePriceCreate', additionalProperties: false },
);
export type ServicePriceCreate = Static<typeof ServicePriceCreate>;

export const PriceList = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    standard: Type.Boolean({ description: 'The list used when none is named.' }),
  },
  { $id: 'PriceList' },
);
export type PriceList = Static<typeof PriceList>;

export const PriceListList = Type.Object(
  { items: Type.Array(ref(PriceList)) },
  { $id: 'PriceListList' },
);

export const ServicePriceListQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
  priceListId: Type.Optional(Type.String({ maxLength: 64 })),
});

export const SERVICE_SCHEMAS = [
  ServicePrice,
  ServicePricePage,
  Service,
  ServicePage,
  ServiceCreate,
  ServiceUpdate,
  ServiceSearchRequest,
  ServicePriceCreate,
  PriceList,
  PriceListList,
] as const;
