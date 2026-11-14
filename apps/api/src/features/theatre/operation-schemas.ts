import { Type, type Static } from '@sinclair/typebox';
import { ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

const Id = Type.String({ maxLength: 64 });
const Lines = (max: number) =>
  Type.Optional(Type.String({ minLength: 1, maxLength: max, pattern: PLAIN_LINES }));

export const OperationNoteInput = Type.Object(
  {
    procedureDone: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    findings: Lines(2000),
    technique: Lines(2000),
    complications: Lines(1000),
    bloodLossMl: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
    specimens: Lines(500),
    postOpPlan: Lines(1000),
  },
  { $id: 'OperationNoteInput', additionalProperties: false },
);
export type OperationNoteInput = Static<typeof OperationNoteInput>;

export const OperationNote = Type.Object(
  {
    procedureDone: Type.String(),
    findings: Type.Optional(Type.String()),
    technique: Type.Optional(Type.String()),
    complications: Type.Optional(Type.String()),
    bloodLossMl: Type.Optional(Type.Integer()),
    specimens: Type.Optional(Type.String()),
    postOpPlan: Type.Optional(Type.String()),
    savedAt: Type.String({ format: 'date-time' }),
    savedBy: Type.String(),
    signedAt: Type.Optional(Type.String({ format: 'date-time' })),
    signedBy: Type.Optional(Type.String()),
    signedByName: Type.Optional(Type.String()),
  },
  { $id: 'OperationNote', additionalProperties: false },
);

export const OperationAddendum = Type.Object(
  {
    id: Type.String(),
    text: Type.String(),
    addedBy: Type.String(),
    addedByName: Type.String(),
    addedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'OperationAddendum', additionalProperties: false },
);

export const OperationRecord = Type.Object(
  {
    surgeryId: Type.String(),
    encounterId: Type.Union([Type.String(), Type.Null()], {
      description: 'The visit the surgery is charged to, when linked.',
    }),
    note: Type.Union([ref(OperationNote), Type.Null()]),
    addenda: Type.Array(ref(OperationAddendum)),
  },
  { $id: 'OperationRecord', additionalProperties: false },
);
export type OperationRecord = Static<typeof OperationRecord>;

export const AddendumInput = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 2000, pattern: PLAIN_LINES }) },
  { $id: 'AddendumInput', additionalProperties: false },
);
export const SurgeryEncounterInput = Type.Object(
  { encounterId: Id },
  { $id: 'SurgeryEncounterInput', additionalProperties: false },
);

export const OPERATION_SCHEMAS = [
  OperationNoteInput,
  OperationNote,
  OperationAddendum,
  OperationRecord,
  AddendumInput,
  SurgeryEncounterInput,
] as const;
