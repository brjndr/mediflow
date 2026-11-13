import { Type, type Static } from '@sinclair/typebox';
import { ref } from '../../core/http/schemas.js';
import { PLAIN_LINES } from '../../core/http/text.js';

export const ADVICE_MAX = 1000;
export const CLEARANCE_NOTE_MAX = 500;

/** The departments that clear a patient to leave. */
export const CLEARANCE_KINDS = ['nursing', 'pharmacy', 'lab'] as const;
export type ClearanceKind = (typeof CLEARANCE_KINDS)[number];

export const DischargeClearanceKind = Type.Unsafe<ClearanceKind>({
  $id: 'DischargeClearanceKind',
  type: 'string',
  enum: [...CLEARANCE_KINDS],
  description: 'Who clears the discharge: nursing, pharmacy returns or pending laboratory work.',
});

export const DischargeClearance = Type.Object(
  {
    kind: ref(DischargeClearanceKind),
    status: Type.Unsafe<'pending' | 'cleared'>({ type: 'string', enum: ['pending', 'cleared'] }),
    note: Type.Optional(Type.String({ maxLength: CLEARANCE_NOTE_MAX })),
    clearedAt: Type.Optional(Type.String({ format: 'date-time' })),
    clearedByName: Type.Optional(Type.String()),
  },
  { $id: 'DischargeClearance', additionalProperties: false },
);

export const DischargePlan = Type.Object(
  {
    admissionId: Type.String(),
    advice: Type.Optional(Type.String({ maxLength: ADVICE_MAX })),
    clearances: Type.Array(ref(DischargeClearance)),
    version: Type.Integer({ minimum: 1 }),
  },
  {
    $id: 'DischargePlan',
    additionalProperties: false,
    description:
      'The advice for the patient and the clearance of nursing, pharmacy and the laboratory; all three are always listed, pending until cleared.',
  },
);

export const DischargeAdviceSet = Type.Object(
  { advice: Type.String({ minLength: 1, maxLength: ADVICE_MAX, pattern: PLAIN_LINES }) },
  { $id: 'DischargeAdviceSet', additionalProperties: false },
);

export const DischargeClearanceSet = Type.Object(
  {
    status: Type.Unsafe<'pending' | 'cleared'>({ type: 'string', enum: ['pending', 'cleared'] }),
    note: Type.Optional(
      Type.String({ minLength: 1, maxLength: CLEARANCE_NOTE_MAX, pattern: PLAIN_LINES }),
    ),
  },
  { $id: 'DischargeClearanceSet', additionalProperties: false },
);

export const ClearanceParams = Type.Object({
  admissionId: Type.String({ maxLength: 64 }),
  kind: Type.String({ maxLength: 32 }),
});

export type DischargeAdviceSet = Static<typeof DischargeAdviceSet>;
export type DischargeClearanceSet = Static<typeof DischargeClearanceSet>;

export const DISCHARGE_PLAN_SCHEMAS = [
  DischargeClearanceKind,
  DischargeClearance,
  DischargePlan,
  DischargeAdviceSet,
  DischargeClearanceSet,
] as const;
