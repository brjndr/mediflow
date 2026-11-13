import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

/**
 * The insurance contract (BE-28, #187). The shapes are the ones the web app was built against in
 * `planned.openapi.json`; the text a person types carries the plain-text pattern the API refuses on.
 */

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({ minimum: 1 });
const DateOnly = Type.String({ format: 'date' });
const Minor = Type.Integer({ minimum: 0 });
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: PLAIN_TEXT });
// A value that may be null is one schema with both types: a union is refused in a body.
const NullableText = (maxLength: number) =>
  Type.Unsafe<string | null>({
    type: ['string', 'null'],
    minLength: 1,
    maxLength,
    pattern: PLAIN_TEXT,
  });
const Code = Type.String({ minLength: 1, maxLength: 20 });

export const PAYER_KINDS = ['insurer', 'tpa', 'corporate'] as const;
export const COVERAGE_MODES = ['all_except', 'only_listed'] as const;
export const RELATIONSHIPS = ['self', 'spouse', 'child', 'parent', 'other'] as const;

export const Payer = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    kind: StringEnum(PAYER_KINDS),
    code: Code,
    name: Text(100),
    contactName: Type.Optional(Text(100)),
    phone: Type.Optional(Text(30)),
    email: Type.Optional(Text(100)),
    address: Type.Optional(Text(300)),
    planCount: Type.Integer({ minimum: 0 }),
    archived: Type.Boolean(),
    version: Version,
  },
  {
    $id: 'Payer',
    description:
      'An insurer, a TPA (which administers claims for insurers) or a corporate with a credit arrangement. Contact details are the organisation’s, never a patient’s.',
  },
);
export type Payer = Static<typeof Payer>;
export const PayerPage = CursorPage(ref(Payer), { $id: 'PayerPage' });

export const PayerCreate = Type.Object(
  {
    kind: StringEnum(PAYER_KINDS),
    code: Code,
    name: Text(100),
    contactName: Type.Optional(Text(100)),
    phone: Type.Optional(Text(30)),
    email: Type.Optional(Text(100)),
    address: Type.Optional(Text(300)),
  },
  { $id: 'PayerCreate', additionalProperties: false },
);
export type PayerCreate = Static<typeof PayerCreate>;

export const PayerUpdate = Type.Object(
  {
    name: Type.Optional(Text(100)),
    contactName: Type.Optional(NullableText(100)),
    phone: Type.Optional(NullableText(30)),
    email: Type.Optional(NullableText(100)),
    address: Type.Optional(NullableText(300)),
    archived: Type.Optional(Type.Boolean()),
    version: Version,
  },
  { $id: 'PayerUpdate', additionalProperties: false },
);
export type PayerUpdate = Static<typeof PayerUpdate>;

const CoverageMode = () =>
  StringEnum(COVERAGE_MODES, {
    description:
      'all_except: everything is covered but the listed services. only_listed: only the listed services are.',
  });
const Copay = () =>
  Type.Integer({
    minimum: 0,
    maximum: 100,
    description: 'The patient’s share of a covered charge, in percent.',
  });
const SumInsured = () =>
  Type.Integer({
    minimum: 0,
    description: 'The most the plan pays in a policy year, in minor units. Absent: no limit.',
  });
const RoomRent = () =>
  Type.Integer({
    minimum: 0,
    description: 'The most it pays for a bed-day, in minor units. Absent: no limit.',
  });
const Age = () => Type.Integer({ minimum: 0, maximum: 120 });
const Waiting = () => Type.Integer({ minimum: 0, maximum: 3650 });
const ServiceWrite = Type.Object(
  { serviceId: Id, limitMinor: Type.Optional(Minor) },
  { additionalProperties: false },
);

export const PayerPlan = Type.Object(
  {
    id: Type.String(),
    payerId: Type.String(),
    code: Code,
    name: Text(100),
    coverageMode: CoverageMode(),
    copayPercent: Copay(),
    sumInsuredMinor: Type.Optional(SumInsured()),
    roomRentLimitMinor: Type.Optional(RoomRent()),
    preAuthRequired: Type.Boolean(),
    minAge: Type.Optional(Age()),
    maxAge: Type.Optional(Age()),
    waitingPeriodDays: Type.Optional(Waiting()),
    services: Type.Array(
      Type.Object({
        serviceId: Type.String(),
        serviceName: Type.String(),
        limitMinor: Type.Optional(Minor),
      }),
    ),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'PayerPlan' },
);
export type PayerPlan = Static<typeof PayerPlan>;

export const PayerPlanWrite = Type.Object(
  {
    code: Code,
    name: Text(100),
    coverageMode: CoverageMode(),
    copayPercent: Copay(),
    sumInsuredMinor: Type.Optional(SumInsured()),
    roomRentLimitMinor: Type.Optional(RoomRent()),
    preAuthRequired: Type.Boolean(),
    minAge: Type.Optional(Age()),
    maxAge: Type.Optional(Age()),
    waitingPeriodDays: Type.Optional(Waiting()),
    services: Type.Array(ServiceWrite, { maxItems: 500 }),
  },
  { $id: 'PayerPlanWrite', additionalProperties: false },
);
export type PayerPlanWrite = Static<typeof PayerPlanWrite>;

export const PayerPlanUpdate = Type.Object(
  {
    name: Type.Optional(Text(100)),
    coverageMode: Type.Optional(CoverageMode()),
    copayPercent: Type.Optional(Copay()),
    sumInsuredMinor: Type.Optional(SumInsured()),
    roomRentLimitMinor: Type.Optional(RoomRent()),
    preAuthRequired: Type.Optional(Type.Boolean()),
    minAge: Type.Optional(Age()),
    maxAge: Type.Optional(Age()),
    waitingPeriodDays: Type.Optional(Waiting()),
    services: Type.Optional(Type.Array(ServiceWrite, { maxItems: 500 })),
    archived: Type.Optional(Type.Boolean()),
    version: Version,
  },
  {
    $id: 'PayerPlanUpdate',
    additionalProperties: false,
    description:
      'The plan’s terms as they should be (the code does not change), or only archived. The services listed replace the old list.',
  },
);
export type PayerPlanUpdate = Static<typeof PayerPlanUpdate>;

export const RateAgreement = Type.Object(
  {
    id: Type.String(),
    payerId: Type.String(),
    name: Text(100),
    effectiveFrom: DateOnly,
    effectiveTo: Type.Optional(
      Type.String({ format: 'date', description: 'The last day it applies. Absent: until ended.' }),
    ),
    discountBp: Type.Integer({
      minimum: 0,
      maximum: 10000,
      description: 'Discount on the price list in basis points (100 = 1%).',
    }),
    rates: Type.Array(
      Type.Object({ serviceId: Type.String(), serviceName: Type.String(), rateMinor: Minor }),
    ),
    version: Version,
  },
  {
    $id: 'RateAgreement',
    description:
      'Prices a payer’s patients are charged between two dates: a discount on the price list, and a rate for a service that replaces the list price.',
  },
);
export type RateAgreement = Static<typeof RateAgreement>;

export const RateAgreementCreate = Type.Object(
  {
    name: Text(100),
    effectiveFrom: DateOnly,
    effectiveTo: Type.Optional(DateOnly),
    discountBp: Type.Integer({ minimum: 0, maximum: 10000 }),
    rates: Type.Array(
      Type.Object({ serviceId: Id, rateMinor: Minor }, { additionalProperties: false }),
      { maxItems: 500 },
    ),
  },
  { $id: 'RateAgreementCreate', additionalProperties: false },
);
export type RateAgreementCreate = Static<typeof RateAgreementCreate>;

export const RateAgreementEnd = Type.Object(
  {
    effectiveTo: Type.Optional(
      Type.Unsafe<string | null>({ type: ['string', 'null'], format: 'date' }),
    ),
    version: Version,
  },
  { $id: 'RateAgreementEnd', additionalProperties: false },
);
export type RateAgreementEnd = Static<typeof RateAgreementEnd>;

export const PayerDetail = Type.Object(
  {
    payer: ref(Payer),
    plans: Type.Array(ref(PayerPlan)),
    agreements: Type.Array(ref(RateAgreement)),
  },
  { $id: 'PayerDetail' },
);

export const PayerListQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  kind: Type.Optional(StringEnum(PAYER_KINDS)),
  archived: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});
export const PayerParams = Type.Object({ payerId: Id });
export const PlanParams = Type.Object({ planId: Id });
export const AgreementParams = Type.Object({ agreementId: Id });

// --- policies -----------------------------------------------------------------------------------

export const PatientPolicy = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    payerId: Type.String(),
    payerName: Type.String(),
    planId: Type.String(),
    planName: Type.String(),
    policyNumber: Text(40),
    memberId: Type.Optional(Text(40)),
    holderName: Text(100),
    relationship: StringEnum(RELATIONSHIPS),
    validFrom: DateOnly,
    validTo: Type.Optional(DateOnly),
    status: StringEnum(['active', 'expired', 'ended'] as const, {
      description: 'Worked out by the server from the dates and whether it was ended.',
    }),
    preAuthRequired: Type.Boolean({
      description: 'Whether the plan asks for pre-authorization of an admission.',
    }),
    version: Version,
  },
  { $id: 'PatientPolicy' },
);
export type PatientPolicy = Static<typeof PatientPolicy>;

export const PatientPolicyCreate = Type.Object(
  {
    planId: Id,
    policyNumber: Text(40),
    memberId: Type.Optional(Text(40)),
    holderName: Text(100),
    relationship: StringEnum(RELATIONSHIPS),
    validFrom: DateOnly,
    validTo: Type.Optional(DateOnly),
  },
  { $id: 'PatientPolicyCreate', additionalProperties: false },
);
export type PatientPolicyCreate = Static<typeof PatientPolicyCreate>;

export const PatientPolicyEnd = Type.Object(
  { version: Version },
  { $id: 'PatientPolicyEnd', additionalProperties: false },
);

export const PatientParams = Type.Object({ patientId: Id });
export const PolicyParams = Type.Object({ policyId: Id });

// --- pre-authorizations -------------------------------------------------------------------------

export const PRE_AUTH_STATUSES = ['submitted', 'approved', 'rejected', 'cancelled'] as const;

export const PreAuth = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    policyId: Type.String(),
    payerName: Type.String(),
    planName: Type.String(),
    policyNumber: Type.String(),
    encounterId: Type.Optional(
      Type.String({ description: 'The visit the cover is for, when known.' }),
    ),
    treatment: Text(300),
    requestedMinor: Minor,
    approvedMinor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'The limit the payer approved. Absent until approved.',
      }),
    ),
    billedMinor: Type.Integer({
      minimum: 0,
      description:
        'What the visit has been charged so far, worked out by the server from the charge ledger.',
    }),
    status: StringEnum(PRE_AUTH_STATUSES),
    referenceNumber: Type.Optional(Text(60)),
    decisionNote: Type.Optional(Text(300)),
    documents: Type.Array(Text(100), {
      maxItems: 20,
      description:
        'What is enclosed with the request, by name. The files are on the patient record (documents).',
    }),
    requestedAt: Type.String({ format: 'date-time' }),
    decidedAt: Type.Optional(Type.String({ format: 'date-time' })),
    version: Version,
  },
  { $id: 'PreAuth' },
);
export type PreAuth = Static<typeof PreAuth>;

export const PreAuthCreate = Type.Object(
  {
    policyId: Id,
    encounterId: Type.Optional(Id),
    treatment: Text(300),
    requestedMinor: Minor,
    documents: Type.Array(Text(100), { maxItems: 20 }),
  },
  { $id: 'PreAuthCreate', additionalProperties: false },
);
export type PreAuthCreate = Static<typeof PreAuthCreate>;

export const PreAuthDecision = Type.Object(
  {
    version: Version,
    outcome: StringEnum(['approved', 'rejected'] as const),
    approvedMinor: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Required when approved.' }),
    ),
    referenceNumber: Type.Optional(Text(60)),
    note: Type.Optional(Text(300)),
  },
  { $id: 'PreAuthDecision', additionalProperties: false },
);
export type PreAuthDecision = Static<typeof PreAuthDecision>;

export const PreAuthCancel = Type.Object(
  { version: Version },
  { $id: 'PreAuthCancel', additionalProperties: false },
);

export const PreAuthParams = Type.Object({ preAuthId: Id });
export const EncounterParams = Type.Object({ encounterId: Id });

export const INSURANCE_SCHEMAS = [
  Payer,
  PayerPage,
  PayerCreate,
  PayerUpdate,
  PayerPlan,
  PayerPlanWrite,
  PayerPlanUpdate,
  RateAgreement,
  RateAgreementCreate,
  RateAgreementEnd,
  PayerDetail,
  PatientPolicy,
  PatientPolicyCreate,
  PatientPolicyEnd,
  PreAuth,
  PreAuthCreate,
  PreAuthDecision,
  PreAuthCancel,
];
