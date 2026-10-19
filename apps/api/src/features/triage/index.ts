import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { TRIAGE_PERMISSIONS } from './permissions.js';
import { UUID } from './repository.js';
import { triageRoutes } from './routes.js';

/**
 * Triage: vital signs, the chief complaint and allergies, taken before the consultation, and the
 * normal ranges they are marked against. Behind the `triage` module flag. Publishes
 * `vitals.recorded` and `allergy.updated`; subscribes to `encounter.opened` to attach a token's
 * readings to the encounter it opened.
 */
export const triageFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('triage', TRIAGE_PERMISSIONS);
  await app.register(triageRoutes);

  // The OPD encounter (M7) opens from a queue token: its readings join it, once. Only this
  // module changes its rows, and a repeated event finds nothing left to set.
  app.events.subscribe('encounter.opened', async (message, tx) => {
    const encounterId = message.entityId;
    const queueTokenId = message.payload.queueTokenId;
    if (typeof encounterId !== 'string' || !UUID.test(encounterId)) return;
    if (typeof queueTokenId !== 'string' || !UUID.test(queueTokenId)) return;
    await tx.execute(
      sql`update vitals set encounter_id = ${encounterId}
          where queue_token_id = ${queueTokenId} and encounter_id is null`,
    );
  });
};
