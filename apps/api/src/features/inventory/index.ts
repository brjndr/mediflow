import type { FastifyPluginAsync } from 'fastify';
import { EXPIRY_JOB, announceExpiringEverywhere } from './expiry.js';
import { INVENTORY_PERMISSIONS } from './permissions.js';
import { inventoryRoutes } from './routes.js';

/**
 * Inventory: the places that keep stock, the batches of the drug and consumable master's items,
 * their stock at each place, the append-only ledger of every change, and adjustments that a
 * second person approves, and indents that a store issues on vouchers (#105). Behind the
 * `inventory` module flag. Checks an item through `stockableDrug` from `features/drugs`.
 * Publishes `stock.adjusted`, `stock.low`, `stock.issued` and, from a daily job, `stock.expiring`. Dispensing, counter sales and goods
 * receipts (#100, #101, #103) post to the same ledger.
 */
export const inventoryFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('inventory', INVENTORY_PERMISSIONS);
  await app.register(inventoryRoutes);
  app.jobs.work(EXPIRY_JOB, () => announceExpiringEverywhere(app.database.pool));
  app.jobs.schedule(EXPIRY_JOB, '15 2 * * *');
};

/**
 * For the pharmacy (#100, #101): the batches that may be given from a place, nearest expiry
 * first, taking units out of stock and putting returned units back through the ledger; for
 * purchasing (#103), bringing received goods in and sending units back to the supplier. So no
 * other module writes stock.
 */
export {
  placeInUse,
  stockIn,
  stockOut,
  stockReceive,
  usableBatches,
  type UsableBatch,
} from './stock-out.js';
