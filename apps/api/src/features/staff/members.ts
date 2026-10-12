import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { grantsWithin } from '../../core/access/policy.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import {
  listPeople,
  lockMember,
  lockOpenInvite,
  lockStaffManagers,
  revokeInvite,
  revokeInvitesSentBy,
  revokeSessionsHere,
  roleGrants,
  setMemberStatus,
  type MemberRow,
  type PersonRow,
} from './repository.js';
import {
  type StaffStatus,
  STAFF_SCHEMAS,
  StaffListQuery,
  StaffMember,
  StaffPage,
  StaffRoleList,
  StaffSessionsRevoked,
} from './schemas.js';

const READ = 'staff:read';
const INVITE = 'staff:invite';
const MANAGE = 'staff:manage';

const person = (row: PersonRow): StaffMember => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  email: row.email,
  roleId: row.role_id,
  roleName: row.role_name,
  status: row.status,
});

const member = (row: MemberRow, status: MemberRow['status']): StaffMember => ({
  id: row.user_id,
  tenantId: row.tenant_id,
  name: row.name,
  email: row.email,
  roleId: row.role_id,
  roleName: row.role_name,
  status: status === 'active' ? 'active' : 'deactivated',
});

// One answer for someone who is not a member here and a user that does not exist.
const notFound = () => new HttpError(404, 'staff_not_found', 'No such member of staff');
const notAllowed = () => new HttpError(403, 'role_not_allowed', 'That role holds more than you do');

const OTHER_HOSPITAL =
  ' Someone who is not a member of the hospital answers 404 staff_not_found, the same as a user that does not exist.';
const CEILING =
  " Nobody acts above themselves: a member whose role holds a permission the caller's role does not is refused with 403 role_not_allowed.";

/** What the caller holds at this hospital. The guard has already established they are a member. */
async function heldBy(request: FastifyRequest) {
  const policy = await request.access.policy();
  if (!policy) throw new HttpError(403, 'permission_denied', 'Not a member of this hospital');
  return policy.permissions;
}

/**
 * The member, locked, once the caller is known to be allowed to act on them: their role holds
 * nothing the caller's does not.
 */
async function memberWithin(request: FastifyRequest, userId: string): Promise<MemberRow> {
  const target = await lockMember(request.txClient, userId);
  if (!target) throw notFound();
  const roles = await roleGrants(request.txClient);
  if (!grantsWithin(roles.get(target.role_id)?.grants ?? [], await heldBy(request))) {
    throw notAllowed();
  }
  return target;
}

export const memberRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of STAFF_SCHEMAS) app.addSchema(schema);

  const UserParams = Type.Object({ userId: Type.String({ maxLength: 64 }) });

  app.get(
    '/staff',
    {
      config: { permissions: [READ] },
      schema: {
        operationId: 'listStaff',
        tags: ['staff'],
        description:
          "The people of the active tenant, by name: its members, or the invitations it has sent that are still open. `q` matches the name or the email address. The hospital is the session's. `total` comes with the first page.",
        querystring: StaffListQuery,
        response: { 200: ref(StaffPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, q = '' } = request.query;
      const status = (request.query.status ?? 'active') as StaffStatus;
      const list = await listPeople(request.txClient, {
        status,
        q: q.trim(),
        cursor,
        limit,
      });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(person),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.get(
    '/staff/roles',
    {
      config: { permissions: [INVITE] },
      schema: {
        operationId: 'listStaffRoles',
        tags: ['staff'],
        description:
          "The roles of the active tenant that the caller may invite someone into, by name: those whose permissions are all held by the caller's own role, so an invitation never grants more than the inviter has (POST /invites refuses the others with 403 role_not_allowed). Ids and names only: what a role may do belongs to role management.",
        response: { 200: ref(StaffRoleList), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => {
      const held = await heldBy(request);
      const roles = await roleGrants(request.txClient);
      return {
        items: [...roles]
          .filter(([, role]) => grantsWithin(role.grants, held))
          .map(([id, role]) => ({ id, name: role.name })),
      };
    },
  );

  app.post(
    '/staff/:userId/deactivate',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'deactivateStaff',
        tags: ['staff'],
        description:
          "Deactivates someone's membership of the hospital: every session they have there ends at once, the open invitations they sent are withdrawn, and they cannot work there until reactivated. Their account and their memberships of other hospitals are untouched, and the membership is kept, never deleted. 409 cannot_deactivate_self for the caller's own membership, 409 last_admin when no other active member could manage staff. Doing it twice changes nothing." +
          CEILING +
          OTHER_HOSPITAL,
        params: UserParams,
        response: { 200: ref(StaffMember), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { userId } = request.params;
      if (userId === request.session?.userId) {
        throw new HttpError(409, 'cannot_deactivate_self', 'You cannot deactivate yourself');
      }
      // Before the member's own row, and in a fixed order: see lockStaffManagers.
      const managers = await lockStaffManagers(request.txClient, MANAGE);
      const target = await memberWithin(request, userId);
      if (managers.includes(target.user_id) && managers.length === 1) {
        throw new HttpError(409, 'last_admin', 'Nobody else could manage the staff here');
      }
      if (await setMemberStatus(request.txClient, target.user_id, 'suspended')) {
        await revokeSessionsHere(request.txClient, target.user_id);
        await revokeInvitesSentBy(request.txClient, target.user_id);
        request.audit('deactivate', 'membership', target.user_id);
      }
      return member(target, 'suspended');
    },
  );

  app.post(
    '/staff/:userId/reactivate',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'reactivateStaff',
        tags: ['staff'],
        description:
          'Makes a deactivated membership active again, in the role it had. Doing it twice changes nothing.' +
          CEILING +
          OTHER_HOSPITAL,
        params: UserParams,
        response: { 200: ref(StaffMember), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const target = await memberWithin(request, request.params.userId);
      if (await setMemberStatus(request.txClient, target.user_id, 'active')) {
        request.audit('reactivate', 'membership', target.user_id);
      }
      return member(target, 'active');
    },
  );

  app.post(
    '/staff/:userId/revoke-sessions',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'revokeStaffSessions',
        tags: ['staff'],
        description:
          "Ends every session the person has at this hospital, so they must sign in again. The caller's own current session is kept." +
          CEILING +
          OTHER_HOSPITAL,
        params: UserParams,
        response: { 200: ref(StaffSessionsRevoked), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const target = await memberWithin(request, request.params.userId);
      const revoked = await revokeSessionsHere(
        request.txClient,
        target.user_id,
        target.user_id === request.session?.userId ? request.session.id : undefined,
      );
      request.audit('revoke_sessions', 'membership', target.user_id);
      return { revoked };
    },
  );

  app.delete(
    '/invites/:inviteId',
    {
      config: { permissions: [INVITE] },
      schema: {
        operationId: 'withdrawInvite',
        tags: ['staff'],
        description:
          "Withdraws an open invitation: its link stops working. For an address that was wrong, since inviting again only sends the same address a new link. An invitation that is not open here (accepted, withdrawn, expired, another hospital's, unknown) answers 404 invite_not_found. The caller must be allowed to give its role (403 role_not_allowed).",
        params: Type.Object({ inviteId: Type.String({ maxLength: 64 }) }),
        response: {
          204: Type.Null({ description: 'Withdrawn' }),
          ...errors(401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      const invite = await lockOpenInvite(request.txClient, request.params.inviteId);
      if (!invite) throw new HttpError(404, 'invite_not_found', 'No such open invitation');
      const roles = await roleGrants(request.txClient);
      if (!grantsWithin(roles.get(invite.role_id)?.grants ?? [], await heldBy(request))) {
        throw notAllowed();
      }
      await revokeInvite(request.txClient, invite.id);
      request.audit('withdraw', 'invite', invite.id);
      return reply.status(204).send(null);
    },
  );
};
