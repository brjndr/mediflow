import type { FastifyPluginAsync } from 'fastify';
import { PURCHASING_PERMISSIONS } from './permissions.js';
import { purchasingRoutes } from './routes.js';

/**
 * Purchasing (#103, #108): the hospital's suppliers, purchase orders that a second person
 * approves, goods received against them, and goods sent back to the supplier. Behind the
 * `purchasing` module flag. Checks an item through `stockableDrug` from `features/drugs`, and
 * moves stock only through inventory's `stockReceive` and `stockOut`, never by writing its tables.
 * Publishes `purchase.order_approved`, `stock.received` and `stock.returned`.
 */
export const purchasingFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('purchasing', PURCHASING_PERMISSIONS);
  await app.register(purchasingRoutes);
};
