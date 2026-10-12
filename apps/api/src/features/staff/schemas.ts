import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';

export const STAFF_STATUSES = ['active', 'deactivated', 'invited'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const StaffMember = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String(),
    email: Type.String(),
    roleId: Type.String(),
    roleName: Type.String(),
    status: StringEnum(STAFF_STATUSES),
  },
  {
    $id: 'StaffMember',
    description:
      'Someone who works at the hospital, or has been invited to. For a member `id` is the user id; for an invitation it is the invitation id.',
  },
);
export type StaffMember = Static<typeof StaffMember>;

export const StaffPage = CursorPage(ref(StaffMember), { $id: 'StaffPage' });

export const StaffRole = Type.Object(
  { id: Type.String(), name: Type.String() },
  { $id: 'StaffRole' },
);

export const StaffRoleList = Type.Object(
  { items: Type.Array(ref(StaffRole)) },
  { $id: 'StaffRoleList' },
);

export const StaffSessionsRevoked = Type.Object(
  { revoked: Type.Integer() },
  { $id: 'StaffSessionsRevoked' },
);

/** Every parameter may be left out: a client asks for the first page of active staff. */
export const StaffListQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
  q: Type.Optional(Type.String({ maxLength: 100 })),
  status: Type.Optional(
    StringEnum(STAFF_STATUSES, {
      description:
        'Which people: active members (when left out), deactivated members, or open invitations.',
    }),
  ),
});

export const STAFF_SCHEMAS = [
  StaffMember,
  StaffPage,
  StaffRole,
  StaffRoleList,
  StaffSessionsRevoked,
] as const;
