import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { WORKER_ROLE } from '../outbox/dispatcher.js';

/**
 * Runs `work` as the worker role in one transaction: link and job work (receiving a file through
 * its signed link, the malware scan, the retention sweep) has no session and so no hospital.
 */
export async function asWorker<T>(
  app: Pick<FastifyInstance, 'database'>,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.database.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Whether the first bytes are those of the type: the sender's word about it is not enough. */
export function looksLike(type: string, data: Buffer): boolean {
  switch (type) {
    case 'image/jpeg':
      return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/png':
      return data
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'application/pdf':
      return data.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'application/dicom':
      return data.length > 132 && data.subarray(128, 132).toString('latin1') === 'DICM';
    default:
      return false;
  }
}
