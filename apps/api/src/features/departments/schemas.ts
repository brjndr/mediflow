import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;

export const Department = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    archived: Type.Boolean(),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
  },
  { $id: 'Department', description: 'A department of one hospital. Holds no patient data.' },
);
export type Department = Static<typeof Department>;

export const DepartmentPage = CursorPage(ref(Department), { $id: 'DepartmentPage' });

const name = Type.String({ minLength: 1, maxLength: NAME_MAX });
const description = Type.String({ maxLength: DESCRIPTION_MAX });

export const DepartmentCreate = Type.Object(
  { name, description: Type.Optional(description) },
  { $id: 'DepartmentCreate', additionalProperties: false },
);
export type DepartmentCreate = Static<typeof DepartmentCreate>;

export const DepartmentUpdate = Type.Object(
  {
    name: Type.Optional(name),
    description: Type.Optional(description),
    expectedVersion: Type.Integer(),
  },
  { $id: 'DepartmentUpdate', additionalProperties: false },
);
export type DepartmentUpdate = Static<typeof DepartmentUpdate>;

/** Every parameter may be left out: a client asks for the first page of active departments. */
export const DepartmentListQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
  archived: Type.Optional(
    Type.Boolean({
      default: false,
      description: 'True lists the archived departments instead of the active ones.',
    }),
  ),
});

export const DEPARTMENT_SCHEMAS = [
  Department,
  DepartmentPage,
  DepartmentCreate,
  DepartmentUpdate,
] as const;
