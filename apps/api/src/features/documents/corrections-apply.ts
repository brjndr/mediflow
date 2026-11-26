import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

/**
 * Applies an approved correction request (#1179). The request's `proposed` text is free text, so
 * the only change that is safe to make by itself is an amendment: a new append-only row that
 * names the target, what was asked, why, and who asked and approved. Nothing in the record's own
 * tables is edited, and the owning module's screens read the amendment beside the record.
 *
 * Per target kind: `patient`, `encounter` and `document` each get the amendment attached to that
 * record. If the target was retired (a document) or is gone by the time the event is handled, the
 * amendment is still kept with the outcome `target_unavailable`, so the decision shows it did
 * not reach a live record. A repeated event does nothing: one amendment per request.
 */
export function applyApprovedCorrections(app: FastifyInstance): void {
  app.events.subscribe('correction.approved', async (message, tx) => {
    const requestId = message.entityId;
    if (!requestId) return;
    const { rows } = await tx.execute<{
      id: string;
      patient_id: string;
      target_kind: 'patient' | 'encounter' | 'document';
      target_id: string | null;
      proposed: string;
      reason: string;
      requested_by: string;
      decided_by: string;
      available: boolean;
    }>(sql`
      select r.id, r.patient_id, r.target_kind, r.target_id, r.proposed, r.reason,
             r.requested_by, r.decided_by,
             case r.target_kind
               when 'patient' then true
               when 'encounter' then exists (select 1 from encounters e where e.id = r.target_id)
               else exists (select 1 from patient_documents d
                             where d.id = r.target_id and d.retired_at is null)
             end as available
        from record_correction_requests r
       where r.id = ${requestId} and r.status = 'approved'`);
    const request = rows[0];
    if (!request) return;
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into record_correction_amendments
        (tenant_id, request_id, patient_id, target_kind, target_id, outcome, proposed, reason,
         requested_by, approved_by)
      values (app_tenant_id(), ${request.id}, ${request.patient_id}, ${request.target_kind},
              ${request.target_id}, ${request.available ? 'applied' : 'target_unavailable'},
              ${request.proposed}, ${request.reason}, ${request.requested_by}, ${request.decided_by})
      on conflict (request_id) do nothing
      returning id`);
    const amendment = inserted.rows[0];
    if (!amendment) return;
    await tx.execute(sql`
      insert into audit_log (tenant_id, actor_id, action, entity, entity_id, request_id, detail)
      values (app_tenant_id(), ${request.decided_by}, 'create', 'record_correction_amendment',
              ${amendment.id}, ${`correction-applied:${request.id}`}, ${`request:${request.id}`})`);
  });
}
