import type { FastifyPluginAsync } from 'fastify';
import {
  documentFileRoutes,
  scanDocument,
  SCAN_JOB,
  sweepDocuments,
  SWEEP_JOB,
  type ScanJob,
} from './files.js';
import { DOCUMENT_PERMISSIONS } from './permissions.js';
import { correctionRoutes } from './corrections.js';
import {
  CONSENT_PERMISSIONS,
  CORRECTION_PERMISSIONS,
  RECORDS_PERMISSIONS,
} from './records-permissions.js';
import { documentRoutes } from './routes.js';
import { insertAuditEntries } from '../../core/audit/plugin.js';

/**
 * Patient documents (#194): files kept on a patient's record, sent through signed links, held
 * until a malware scan clears them, retired with a reason and never deleted by a person. A daily
 * sweep removes the file of a document past its category's retention. Behind the `documents`
 * module flag. A merge of two patient records (in `features/patients`) moves the documents.
 */
export const documentsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('documents', DOCUMENT_PERMISSIONS);
  app.permissions.register('consents', CONSENT_PERMISSIONS);
  app.permissions.register('records', [...RECORDS_PERMISSIONS, ...CORRECTION_PERMISSIONS]);
  // A merged record's documents go to the survivor, whatever the hospital's switch says.
  app.patientMerge.register(
    'documents',
    async (client, { sourceId, targetId }) => {
      const moved = await client.query(
        'update patient_documents set patient_id = $2 where patient_id = $1',
        [sourceId, targetId],
      );
      // A hold on the whole record follows its documents to the survivor (#629). The source's own
      // hold stays as it was, so placing and releasing keep their history.
      const held = await client.query(
        `insert into document_legal_holds (tenant_id, patient_id, reason, placed_by, placed_at,
           merged_from_patient_id)
         select h.tenant_id, $2, h.reason, h.placed_by, h.placed_at, $1
           from document_legal_holds h
          where h.patient_id = $1 and h.document_id is null and h.released_at is null`,
        [sourceId, targetId],
      );
      // The copied holds count too, so a merge with only a hold is still undone (#866).
      return (moved.rowCount ?? 0) + (held.rowCount ?? 0);
    },
    async (client, { sourceId }) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*) as n from patient_documents where patient_id = $1',
        [sourceId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    // An unmerge (#555): documents that came from the source go back to it, and the whole-record
    // hold the merge copied to the survivor is released (#866) in the name of the person who
    // unmerged. A hold placed on the survivor by hand has no `merged_from_patient_id` and stays.
    async (client, { sourceId, targetId }) => {
      const back = await client.query(
        'update patient_documents set patient_id = $1 where patient_id = $2 and original_patient_id = $1',
        [sourceId, targetId],
      );
      const released = await client.query<{ id: string; by: string; merge_id: string }>(
        `update document_legal_holds h set released_at = now(), released_by = m.unmerged_by
           from patient_merges m
          where h.patient_id = $2 and h.merged_from_patient_id = $1 and h.document_id is null
            and h.released_at is null and m.source_patient_id = $1 and m.target_patient_id = $2
            and m.unmerged_at = (select max(unmerged_at) from patient_merges
                                  where source_patient_id = $1 and target_patient_id = $2)
        returning h.id, m.unmerged_by as by, m.id as merge_id`,
        [sourceId, targetId],
      );
      // The reason is the unmerge's own, kept on the merge row that the entry names.
      await insertAuditEntries(
        client,
        released.rows[0]?.by ?? null,
        `unmerge:${sourceId}`,
        released.rows.map((row) => ({
          action: 'update',
          entity: 'document_legal_hold',
          entityId: row.id,
          detail: `unmerge:${row.merge_id}`,
        })),
      );
      return back.rowCount ?? 0;
    },
  );
  await app.register(documentRoutes);
  await app.register(documentFileRoutes);
  await app.register(correctionRoutes);
  app.jobs.work<ScanJob>(SCAN_JOB, (job) => scanDocument(app, job));
  app.jobs.work(SWEEP_JOB, async () => {
    const failed = await sweepDocuments(app);
    if (failed.length > 0) {
      app.log.warn({ event: 'document_file_delete_failed', count: failed.length }, 'files kept');
    }
  });
  app.jobs.schedule(SWEEP_JOB, '30 3 * * *');
};
