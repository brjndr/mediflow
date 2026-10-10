import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { issueInvite, sendInvite } from '../../core/auth/invites.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';

export const Invite = Type.Object(
  {
    id: Type.String(),
    email: Type.String(),
    roleId: Type.String(),
    expiresInHours: Type.Integer(),
  },
  { $id: 'Invite', description: 'An invitation that has been emailed. The link is not returned.' },
);

/** One address, as the notifier will accept it. The database stores it lower-cased. */
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const staffRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addSchema(Invite);

  app.post(
    '/invites',
    {
      config: { permissions: ['staff:invite'] },
      schema: {
        operationId: 'createInvite',
        tags: ['staff'],
        description:
          'Invites someone to the active hospital in one of its roles and emails them a single-use link. A newer invite to the same address replaces an older one.',
        body: Type.Object({
          email: Type.String({ minLength: 3, maxLength: 254 }),
          name: Type.String({ minLength: 1, maxLength: 200 }),
          roleId: Type.String({ minLength: 1, maxLength: 63 }),
        }),
        response: { 201: ref(Invite), ...errors(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      const { email, name, roleId } = request.body;
      if (!EMAIL.test(email.trim()) || name.trim() === '') {
        throw new HttpError(400, 'validation_failed', 'A name and one valid email are required');
      }
      // Row-level security limits this to the active hospital's own roles.
      const role = await request.txClient.query('select 1 from roles where id = $1', [roleId]);
      if (role.rowCount === 0) throw new HttpError(400, 'unknown_role', 'No such role here');

      const invite = await issueInvite(request.txClient, app.config, {
        email,
        name,
        roleId,
        invitedBy: request.session?.userId ?? null,
      });
      // Only once the invite is really saved, and without holding the response for the mailer.
      request.afterCommit(() => sendInvite(app.notifier, invite));

      return reply.status(201).send({
        id: invite.id,
        email: invite.email,
        roleId,
        expiresInHours: invite.expiresInHours,
      });
    },
  );
};
