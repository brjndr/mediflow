import type { FastifyPluginAsync } from 'fastify';
import { INVENTORY_PERMISSIONS } from './permissions.js';
import { inventoryRoutes } from './routes.js';

/**
 * Inventory: the places that keep stock, the batches of the drug and consumable master's items,
 * their stock at each place, the append-only ledger of every change, and adjustments that a
 * second person approves. Behind the `inventory` module flag. Checks an item through
 * `stockableDrug` from `features/drugs`. Publishes `stock.adjusted` and `stock.low`.
 * Dispensing, goods receipts and indents (#100, #103, #105) post to the same ledger.
 */
export const inventoryFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('inventory', INVENTORY_PERMISSIONS);
  await app.register(inventoryRoutes);
};

/**
 * For the pharmacy (#100, #101): the batches that may be given from a place, nearest expiry
 * first, taking units out of stock and putting returned units back through the ledger, so no
 * other module writes stock.
 */
export { stockIn, stockOut, usableBatches, type UsableBatch } from './stock-out.js';
