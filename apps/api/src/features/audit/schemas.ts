import { Type } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';

/** Most days one search covers. */
export const MAX_AUDIT_DAYS = 92;

export const AuditSearchRequest = Type.Object(
  {
    from: Type.String({ format: 'date', description: 'First day, at the hospital (YYYY-MM-DD).' }),
    to: Type.String({
      format: 'date',
      description: `Last day, included. At most ${MAX_AUDIT_DAYS} days from \`from\`.`,
    }),
    actorId: Type.Optional(Type.String({ maxLength: 64, description: 'The account that acted.' })),
    entity: Type.Optional(Type.String({ maxLength: 63, description: 'Kind of record, exact.' })),
    entityId: Type.Optional(Type.String({ maxLength: 64, description: 'The record, exact.' })),
    action: Type.Optional(Type.String({ maxLength: 63, description: 'The action, exact.' })),
    cursor: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
    ),
  },
  { $id: 'AuditSearchRequest', additionalProperties: false },
);

export const AuditEntry = Type.Object(
  {
    id: Type.String(),
    at: Type.String({ format: 'date-time' }),
    actor: Type.Union([
      Type.Object({ id: Type.String(), name: Type.String() }),
      Type.Null({ description: 'No account: work the system did by itself.' }),
    ]),
    action: Type.String(),
    entity: Type.String(),
    entityId: Type.Union([Type.String(), Type.Null()]),
    detail: Type.Union([Type.String(), Type.Null()]),
  },
  {
    $id: 'AuditEntry',
    description:
      'One line of the audit log. Record ids only: no patient is named and no field value is kept.',
  },
);

export const AuditPage = CursorPage(ref(AuditEntry), { $id: 'AuditPage' });

export const AUDIT_SCHEMAS = [AuditSearchRequest, AuditEntry, AuditPage];
