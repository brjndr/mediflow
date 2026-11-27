import type { FastifyRequest } from 'fastify';
import { grantsWithin } from '../../core/access/policy.js';
import { withdrawInvitesBeyondSender } from '../../core/auth/invite-ceiling.js';
import { lockOpenInvitesSentBy, revokeInvite, roleGrants } from './repository.js';

const INVITE = 'staff:invite';

/**
 * An invitation stands on its sender's word: withdraws, and audits, the open invitations these
 * members sent that somebody holding `held` could not send (no staff:invite, or a role holding
 * more than they do). The roles are read as they are now, so call it after the change, with the
 * hospital's role-change lock held.
 */
export async function withdrawUnsendableInvites(
  request: FastifyRequest,
  senderIds: readonly string[],
  held: readonly { permission: string; scope?: string }[],
): Promise<void> {
  const invites = await lockOpenInvitesSentBy(request.txClient, senderIds);
  if (invites.length === 0) return;
  const roles = await roleGrants(request.txClient);
  const mayInvite = held.some((grant) => grant.permission === INVITE);
  for (const invite of invites) {
    if (mayInvite && grantsWithin(roles.get(invite.role_id)?.grants ?? [], held)) continue;
    await revokeInvite(request.txClient, invite.id);
    request.audit('withdraw', 'invite', invite.id);
  }
}

/**
 * The other side of the same rule (#1224): after a role gained permissions, withdraws, and
 * audits, the open invitations into it that their sender could no longer send. Call it after the
 * change, with the hospital's role-change lock held.
 */
export async function withdrawInvitesOutgrown(
  request: FastifyRequest,
  roleId: string,
): Promise<void> {
  for (const id of await withdrawInvitesBeyondSender(request.txClient, roleId)) {
    request.audit('withdraw', 'invite', id);
  }
}
