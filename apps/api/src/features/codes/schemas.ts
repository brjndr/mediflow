import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const CODE_SYSTEMS = ['icd10', 'procedure'] as const;
export type CodeSystem = (typeof CODE_SYSTEMS)[number];

export const CODE_MAX = 20;
export const TITLE_MAX = 300;

export const Code = Type.Object(
  {
    id: Type.String(),
    system: StringEnum(CODE_SYSTEMS),
    code: Type.String({ description: 'As it is written: A09, E11.9.' }),
    title: Type.String(),
    favourite: Type.Boolean({ description: 'Whether the active tenant marked it.' }),
  },
  {
    $id: 'Code',
    description:
      'A diagnosis code (ICD-10) or a procedure code. Reference data shared by every hospital, so it carries no tenant; only `favourite` is the hospital’s own.',
  },
);
export type Code = Static<typeof Code>;

export const CodePage = CursorPage(ref(Code), { $id: 'CodePage' });

/**
 * In the body, never the query string: see Searches in the root CLAUDE.md. No default value on
 * the fields of a body: the generated client would make them required.
 */
export const CodeSearchRequest = Type.Object(
  {
    system: StringEnum(CODE_SYSTEMS, { description: 'The code set to search.' }),
    q: Type.Optional(Type.String({ maxLength: 100, pattern: PLAIN_TEXT })),
    favourites: Type.Optional(
      Type.Boolean({ description: 'True gives the favourites only. Absent: false.' }),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 1024,
        description: 'Opaque. Pass the nextCursor of the previous page.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'Absent: 25.' }),
    ),
  },
  { $id: 'CodeSearchRequest', additionalProperties: false },
);
export type CodeSearchRequest = Static<typeof CodeSearchRequest>;

export const CODE_SCHEMAS = [Code, CodePage, CodeSearchRequest] as const;
