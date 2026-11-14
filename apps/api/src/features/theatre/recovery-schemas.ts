import { Type, type Static } from '@sinclair/typebox';
import { ref } from '../../core/http/schemas.js';
import { PLAIN_LINES } from '../../core/http/text.js';

const READINESS = ['in_recovery', 'ready_for_ward'] as const;
export const RecoveryReadiness = Type.Unsafe<(typeof READINESS)[number]>({
  $id: 'RecoveryReadiness',
  type: 'string',
  enum: [...READINESS],
});

export const RecoveryNoteInput = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000, pattern: PLAIN_LINES }),
    painScore: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    readiness: ref(RecoveryReadiness),
  },
  { $id: 'RecoveryNoteInput', additionalProperties: false },
);
export type RecoveryNoteInput = Static<typeof RecoveryNoteInput>;

export const RecoveryNote = Type.Object(
  {
    id: Type.String(),
    text: Type.String(),
    painScore: Type.Union([Type.Integer({ minimum: 0, maximum: 10 }), Type.Null()]),
    readiness: ref(RecoveryReadiness),
    addedBy: Type.String(),
    addedByName: Type.String(),
    addedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'RecoveryNote', additionalProperties: false },
);

export const RecoveryRecord = Type.Object(
  {
    surgeryId: Type.String(),
    encounterId: Type.Union([Type.String(), Type.Null()], {
      description: 'The visit the surgery is charged to, when linked.',
    }),
    notes: Type.Array(ref(RecoveryNote)),
  },
  { $id: 'RecoveryRecord', additionalProperties: false },
);
export type RecoveryRecord = Static<typeof RecoveryRecord>;

export const RECOVERY_SCHEMAS = [
  RecoveryReadiness,
  RecoveryNoteInput,
  RecoveryNote,
  RecoveryRecord,
] as const;
