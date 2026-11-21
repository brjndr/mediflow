import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Static } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { searchAudit } from './repository.js';
import { AUDIT_SCHEMAS, AuditPage, AuditSearchRequest, MAX_AUDIT_DAYS } from './schemas.js';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayNumber = (value: string): number | null => {
  const match = DAY.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return ms / 86_400_000;
};

export const auditRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of AUDIT_SCHEMAS) app.addSchema(schema);

  app.post(
    '/audit/search',
    {
      config: { permissions: ['auditLog:read'], feature: 'audit_log' },
      schema: {
        operationId: 'searchAuditLog',
        tags: ['audit'],
        description: `The hospital's audit log, newest first, paged by cursor. A range of days at the hospital's clock is required, at most ${MAX_AUDIT_DAYS} days (422 \`range_invalid\`, \`range_too_long\`). Filters: the account that acted, the kind of record, the record, the action, all exact, and free text q (part of the action or of the kind of record, any case). Entries hold record ids only, never a patient's name. The body is a POST so the filters stay out of logs. Requires auditLog:read with the scope \`all\` and the audit_log feature flag. The read is itself audited (a read of \`audit_log\`).`,
        body: ref(AuditSearchRequest),
        response: { 200: ref(AuditPage), ...errors(400, 401, 403, 409, 422) },
      },
    },
    async (request) => {
      if (request.access.scope('auditLog:read') !== 'all') {
        throw new HttpError(403, 'permission_denied', 'The audit log needs the scope all');
      }
      const body = request.body as Static<typeof AuditSearchRequest>;
      const first = dayNumber(body.from);
      const last = dayNumber(body.to);
      if (first === null || last === null || first > last) {
        throw new HttpError(422, 'range_invalid', 'from and to must be days, from not after to');
      }
      if (last - first + 1 > MAX_AUDIT_DAYS) {
        throw new HttpError(
          422,
          'range_too_long',
          `A search covers at most ${MAX_AUDIT_DAYS} days`,
        );
      }
      const page = await searchAudit(request.txClient, {
        from: body.from,
        to: body.to,
        ...(body.actorId === undefined ? {} : { actorId: body.actorId }),
        ...(body.entity === undefined ? {} : { entity: body.entity }),
        ...(body.entityId === undefined ? {} : { entityId: body.entityId }),
        ...(body.action === undefined ? {} : { action: body.action }),
        ...(body.q === undefined ? {} : { q: body.q }),
        ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
        limit: body.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
      request.audit('read', 'audit_log');
      return page;
    },
  );
};
