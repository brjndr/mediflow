import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';

type Entry = components['schemas']['AuditEntry'];

const FEATURE_FLAG = 'audit_log';
const MAX_DAYS = 92;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What the log holds, by hospital. Record ids only, never a patient name. */
const LOG: Record<string, Omit<Entry, 'at'>[]> = {
  [TENANT_IDS.hospital]: Array.from({ length: 60 }, (_, index) => ({
    id: `aud_h_${String(index + 1).padStart(3, '0')}`,
    actor: { id: USER_IDS.admin, name: 'Sample Admin' },
    action: index % 3 === 0 ? 'update' : 'read',
    entity: index % 5 === 0 ? 'invoice' : 'patient',
    entityId: `rec_${index + 1}`,
    detail: null,
  })),
  [TENANT_IDS.clinic]: [
    {
      id: 'aud_c_001',
      actor: { id: USER_IDS.doctor, name: 'Sample Doctor' },
      action: 'read',
      entity: 'patient',
      entityId: 'rec_clinic',
      detail: null,
    },
  ],
};

interface Body {
  from?: string;
  to?: string;
  actorId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  cursor?: string;
  limit?: number;
}

const dayNumber = (day: string) => Date.parse(`${day}T12:00:00Z`) / 86_400_000;

export const auditHandlers = [
  http.post('*/api/audit/search', async ({ request }) => {
    const access = authorize(request, { permission: 'auditLog:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => ({}))) as Body;
    if (!body.from || !body.to || !DAY.test(body.from) || !DAY.test(body.to)) {
      return error(400, 'validation_failed', 'Days are needed');
    }
    const span = Math.round(dayNumber(body.to) - dayNumber(body.from)) + 1;
    if (span < 1) return error(422, 'range_invalid', 'The days are the wrong way round');
    if (span > MAX_DAYS) return error(422, 'range_too_long', 'Too many days');

    // Tenant isolation: only the session's hospital's entries are ever considered. The entries
    // fall on the last day asked for, newest first.
    const all = (LOG[access.tenantId] ?? [])
      .map((row, index) => ({
        ...row,
        at: new Date(Date.parse(`${body.to}T06:30:00Z`) - index * 60_000).toISOString(),
      }))
      .filter(
        (row) =>
          (!body.actorId || row.actor?.id === body.actorId) &&
          (!body.entity || row.entity === body.entity) &&
          (!body.entityId || row.entityId === body.entityId) &&
          (!body.action || row.action === body.action),
      );
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 100);
    const start = body.cursor ? Number(body.cursor) : 0;
    if (!Number.isInteger(start) || start < 0) {
      return error(400, 'invalid_cursor', 'Unknown cursor');
    }
    return HttpResponse.json({
      items: all.slice(start, start + limit),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    });
  }),
];
