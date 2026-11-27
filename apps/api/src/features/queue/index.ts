import type { FastifyPluginAsync } from 'fastify';
import { QUEUE_PERMISSIONS } from './permissions.js';
import { queueRoutes } from './routes.js';

/**
 * The OPD token queue: today's tokens per department, issued at the desk and called by doctors,
 * with a live stream of which department's queue changed. Behind the `queue` module flag.
 * Publishes `queue.token_issued` and `queue.called`.
 */
export const queueFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('queue', QUEUE_PERMISSIONS);
  await app.register(queueRoutes);
};

/** For triage: is a token the patient's and today's at the hospital. */
export { tokenOfPatientToday } from './repository.js';

/** For the clinical module: the patient's token of today, and its doctor, to open an encounter. */
export { tokenForEncounter } from './repository.js';

/** For the appointments module's OPD capacity: today's waiting and called tokens, counts only. */
export { queueCountsToday, type QueueCountsToday } from './repository.js';

/** For the clinical module: what a token of today says on the paper OPD sheet (#1201). */
export { todaysToken } from './repository.js';

/** For the paper OPD sheet (#1202): the number of the token a visit was opened from. */
export { tokenNumberOf } from './repository.js';
