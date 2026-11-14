import type { FastifyPluginAsync } from 'fastify';
import { BED_CHARGE_JOB, postBedDaysEverywhere } from './bed-days.js';
import { BILLING_PERMISSIONS } from './permissions.js';
import { subscribeToPostings } from './posting.js';
import { billingRoutes } from './routes.js';
import { billDischargeGate } from './stay-routes.js';

/**
 * Billing (#114): the charge ledger, posted from the events of the clinical, laboratory,
 * radiology and pharmacy modules; invoices assembled from charges, issued with a number of the
 * fiscal year and never changed after; payments, refunds and credit notes; cash register
 * sessions and the day-end settlement. Behind the `billing` module flag. Publishes
 * `charge.posted`, `invoice.issued`, `invoice.paid`, `payment.refunded`, `invoice.credited` and
 * `register.closed`; subscribes to `order.completed`, `pharmacy.dispensed` and
 * `pharmacy.dispense_returned`, `surgery.completed` and `surgery.consumables_used`. No other module writes a charge or an invoice.
 */
export const billingFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('billing', BILLING_PERMISSIONS);
  await app.register(billingRoutes);
  subscribeToPostings(app);
  app.dischargeGates.register('billing', billDischargeGate);
  app.jobs.work(BED_CHARGE_JOB, () => postBedDaysEverywhere(app.database.pool));
  app.jobs.schedule(BED_CHARGE_JOB, '10 * * * *');
};
