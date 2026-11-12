import { Type, type Static } from '@sinclair/typebox';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

export const ADDRESS_MAX = 300;
export const PHONE_MAX = 50;
export const REGISTRATION_MAX = 50;
/** 15 characters, the first two digits. Stored in capitals (the database checks that). */
export const GSTIN_PATTERN = '^[0-9]{2}[A-Za-z0-9]{13}$';

export const HospitalProfile = Type.Object(
  {
    address: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    registrationNumber: Type.Optional(Type.String()),
    gstin: Type.Optional(Type.String()),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
  },
  {
    $id: 'HospitalProfile',
    description:
      'What the hospital prints on its letterhead and invoices. A detail that is not set is absent. Holds no patient data.',
  },
);
export type HospitalProfile = Static<typeof HospitalProfile>;

export const HospitalProfileUpdate = Type.Object(
  {
    address: Type.Optional(Type.String({ maxLength: ADDRESS_MAX, pattern: PLAIN_LINES })),
    phone: Type.Optional(Type.String({ maxLength: PHONE_MAX, pattern: PLAIN_TEXT })),
    registrationNumber: Type.Optional(
      Type.String({ maxLength: REGISTRATION_MAX, pattern: PLAIN_TEXT }),
    ),
    gstin: Type.Optional(Type.String({ pattern: `${GSTIN_PATTERN}|^$` })),
    expectedVersion: Type.Integer(),
  },
  { $id: 'HospitalProfileUpdate', additionalProperties: false },
);
export type HospitalProfileUpdate = Static<typeof HospitalProfileUpdate>;

export const HOSPITAL_PROFILE_SCHEMAS = [HospitalProfile, HospitalProfileUpdate] as const;
