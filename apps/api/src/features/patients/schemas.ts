import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';

const Gender = StringEnum(['male', 'female', 'other']);
const IsoDate = Type.String({ format: 'date' });
const Name = Type.String({ minLength: 1, maxLength: 100 });
const Phone = Type.String({ minLength: 5, maxLength: 20 });

export const PatientSummary = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    mrn: Type.String({ description: 'Unique per tenant' }),
    firstName: Type.String(),
    lastName: Type.String(),
    dob: IsoDate,
    gender: Gender,
    phone: Type.String({
      description: 'Masked to its last four digits for a caller without patient.contact:read.',
    }),
  },
  {
    $id: 'PatientSummary',
    description: 'A patient as shown in a list: compact, no clinical data.',
  },
);

export const PatientPage = CursorPage(ref(PatientSummary), { $id: 'PatientPage' });

const ContactConsent = Type.Object({
  given: Type.Boolean(),
  at: Type.String({ format: 'date-time' }),
  recordedBy: Type.String(),
});

export const PatientRecord = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    mrn: Type.String({ description: 'Unique per tenant' }),
    firstName: Type.String(),
    lastName: Type.String(),
    dob: IsoDate,
    gender: Gender,
    phone: Type.String({
      description: 'Masked to its last four digits for a caller without patient.contact:read.',
    }),
    email: Type.Optional(Type.String()),
    address: Type.Optional(Type.String()),
    contactConsent: Type.Optional(ContactConsent),
    version: Type.Integer({
      minimum: 1,
      description:
        'Goes up by one each time the record changes. Send it back as expectedVersion when changing the record.',
    }),
  },
  {
    $id: 'PatientRecord',
    description:
      'A registered patient with the details captured at registration. Email and address are left out for a caller without patient.contact:read.',
  },
);

/** Only the decision is sent; the server adds when and by whom. */
const ConsentDecision = Type.Object({ given: Type.Boolean() });

export const PatientCreate = Type.Object(
  {
    firstName: Name,
    lastName: Name,
    dob: IsoDate,
    gender: Gender,
    phone: Phone,
    email: Type.Optional(Type.String({ maxLength: 254 })),
    address: Type.Optional(Type.String({ maxLength: 500 })),
    contactConsent: Type.Optional(ConsentDecision),
  },
  { $id: 'PatientCreate', additionalProperties: false },
);
export type PatientCreate = Static<typeof PatientCreate>;

export const PatientUpdate = Type.Object(
  {
    expectedVersion: Type.Integer({
      minimum: 1,
      description:
        'The version of the record the change was made from. If the record has changed since, the request is refused with 409 conflict and nothing is changed.',
    }),
    firstName: Type.Optional(Name),
    lastName: Type.Optional(Name),
    dob: Type.Optional(IsoDate),
    gender: Type.Optional(Gender),
    phone: Type.Optional(Phone),
    email: Type.Optional(Type.Union([Type.String({ maxLength: 254 }), Type.Null()])),
    address: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
    contactConsent: Type.Optional(ConsentDecision),
  },
  {
    $id: 'PatientUpdate',
    additionalProperties: false,
    minProperties: 2,
    description:
      'The version the change is based on, and the fields to change. Null clears an optional field. The MRN never changes.',
  },
);
export type PatientUpdate = Static<typeof PatientUpdate>;

export const PATIENT_SORTS = ['name', '-name', 'mrn', '-mrn'] as const;
export type PatientSort = (typeof PATIENT_SORTS)[number];

/** In the body, never the query string: the term can be a name, a phone number or an MRN. */
export const PatientSearch = Type.Object(
  {
    q: Type.Optional(
      Type.String({ maxLength: 100, description: 'Search text: name, phone or MRN.' }),
    ),
    cursor: Type.Optional(
      Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
    ),
    sort: Type.Optional(StringEnum(PATIENT_SORTS)),
  },
  { additionalProperties: false },
);

export const PatientDuplicateQuery = Type.Object(
  { firstName: Name, lastName: Name, dob: IsoDate, phone: Phone },
  { $id: 'PatientDuplicateQuery', additionalProperties: false },
);

export const PatientDuplicateMatch = Type.Object(
  {
    firstName: Type.String(),
    lastName: Type.String(),
    dob: IsoDate,
    maskedMrn: Type.String(),
    maskedPhone: Type.String(),
  },
  {
    $id: 'PatientDuplicateMatch',
    description:
      'A possible duplicate, masked by the server: enough to recognise the person, not to read their details. No id.',
  },
);

export const PatientDuplicateMatches = Type.Object(
  { items: Type.Array(ref(PatientDuplicateMatch)) },
  { $id: 'PatientDuplicateMatches' },
);

export const PATIENT_SCHEMAS = [
  PatientSummary,
  PatientPage,
  PatientRecord,
  PatientCreate,
  PatientUpdate,
  PatientDuplicateQuery,
  PatientDuplicateMatch,
  PatientDuplicateMatches,
] as const;
