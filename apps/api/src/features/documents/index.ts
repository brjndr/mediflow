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
import { documentRoutes } from './routes.js';

/**
 * Patient documents (#194): files kept on a patient's record, sent through signed links, held
 * until a malware scan clears them, retired with a reason and never deleted by a person. A daily
 * sweep removes the file of a document past its category's retention. Behind the `documents`
 * module flag. A merge of two patient records (in `features/patients`) moves the documents.
 */
export const documentsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('documents', DOCUMENT_PERMISSIONS);
  // A merged record's documents go to the survivor, whatever the hospital's switch says.
  app.patientMerge.register(
    'documents',
    async (client, { sourceId, targetId }) => {
      const moved = await client.query(
        'update patient_documents set patient_id = $2 where patient_id = $1',
        [sourceId, targetId],
      );
      return moved.rowCount ?? 0;
    },
    async (client, { sourceId }) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*) as n from patient_documents where patient_id = $1',
        [sourceId],
      );
      return Number(rows[0]?.n ?? 0);
    },
  );
  await app.register(documentRoutes);
  await app.register(documentFileRoutes);
  app.jobs.work<ScanJob>(SCAN_JOB, (job) => scanDocument(app, job));
  app.jobs.work(SWEEP_JOB, async () => {
    const failed = await sweepDocuments(app);
    if (failed.length > 0) {
      app.log.warn({ event: 'document_file_delete_failed', count: failed.length }, 'files kept');
    }
  });
  app.jobs.schedule(SWEEP_JOB, '30 3 * * *');
};
