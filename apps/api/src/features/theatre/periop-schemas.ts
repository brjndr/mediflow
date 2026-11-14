import { Type, type Static } from '@sinclair/typebox';
import { ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

export const FITNESS_STATUSES = ['fit', 'conditional', 'unfit'] as const;
export const FitnessStatus = Type.Unsafe<(typeof FITNESS_STATUSES)[number]>({
  $id: 'FitnessStatus',
  type: 'string',
  enum: [...FITNESS_STATUSES],
});

/** The checklist as phases in the order they are done; a step needs every step of earlier phases. */
export const CHECKLIST_PHASES = [
  ['consent_confirmed', 'site_marked', 'fasting_confirmed'],
  ['identity_confirmed', 'anaesthesia_check_done', 'allergies_checked'],
  ['team_introduced', 'procedure_confirmed', 'antibiotic_given'],
  ['counts_correct', 'specimens_labelled', 'concerns_handed_over'],
] as const;
export const CHECKLIST_STEPS = CHECKLIST_PHASES.flat();
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];
export const ChecklistStepCode = Type.Unsafe<ChecklistStep>({
  $id: 'ChecklistStepCode',
  type: 'string',
  enum: [...CHECKLIST_STEPS],
});

export const TECHNIQUES = [
  'general',
  'spinal',
  'epidural',
  'regional',
  'local',
  'sedation',
] as const;
const Technique = Type.Unsafe<(typeof TECHNIQUES)[number]>({
  type: 'string',
  enum: [...TECHNIQUES],
});

export const ChecklistEntry = Type.Object(
  {
    step: ref(ChecklistStepCode),
    completedAt: Type.String({ format: 'date-time' }),
    completedBy: Type.String(),
    completedByName: Type.String(),
    note: Type.Optional(Type.String()),
  },
  { $id: 'ChecklistEntry', additionalProperties: false },
);

export const Fitness = Type.Object(
  {
    status: ref(FitnessStatus),
    notes: Type.Optional(Type.String()),
    assessedAt: Type.String({ format: 'date-time' }),
    assessedBy: Type.String(),
    assessedByName: Type.String(),
  },
  { $id: 'Fitness', additionalProperties: false },
);

export const AnaesthesiaInput = Type.Object(
  {
    technique: Technique,
    asaClass: Type.Integer({ minimum: 1, maximum: 6 }),
    drugs: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: PLAIN_LINES })),
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: PLAIN_LINES })),
  },
  { $id: 'AnaesthesiaInput', additionalProperties: false },
);

export const Anaesthesia = Type.Object(
  {
    technique: Technique,
    asaClass: Type.Integer({ minimum: 1, maximum: 6 }),
    drugs: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    savedAt: Type.String({ format: 'date-time' }),
    signedAt: Type.Optional(Type.String({ format: 'date-time' })),
    signedBy: Type.Optional(Type.String()),
    signedByName: Type.Optional(Type.String()),
  },
  { $id: 'Anaesthesia', additionalProperties: false },
);

export const PeriopRecord = Type.Object(
  {
    surgeryId: Type.String(),
    checklist: Type.Array(ref(ChecklistEntry)),
    fitness: Type.Union([ref(Fitness), Type.Null()]),
    anaesthesia: Type.Union([ref(Anaesthesia), Type.Null()]),
  },
  { $id: 'PeriopRecord', additionalProperties: false },
);
export type PeriopRecord = Static<typeof PeriopRecord>;

export const FitnessInput = Type.Object(
  {
    status: ref(FitnessStatus),
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_LINES })),
  },
  { $id: 'FitnessInput', additionalProperties: false },
);
export const ChecklistStepInput = Type.Object(
  { note: Type.Optional(Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT })) },
  { $id: 'ChecklistStepInput', additionalProperties: false },
);
export const ChecklistParams = Type.Object({
  surgeryId: Type.String({ maxLength: 64 }),
  step: ref(ChecklistStepCode),
});

export const PERIOP_SCHEMAS = [
  FitnessStatus,
  ChecklistStepCode,
  ChecklistEntry,
  Fitness,
  AnaesthesiaInput,
  Anaesthesia,
  PeriopRecord,
  FitnessInput,
  ChecklistStepInput,
] as const;
