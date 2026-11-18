import type { FastifyPluginAsync } from 'fastify';
import { CLAIM_SCHEMAS } from './claim-schemas.js';
import { CREDIT_SCHEMAS } from './credit-schemas.js';
import { creditRoutes } from './credit.js';
import { CLAIM_FILE_SCHEMAS, claimFileRoutes } from './claim-files.js';
import { claimExportRoutes, CLAIM_EXPORT_SCHEMAS } from './claim-export.js';
import { claimRoutes } from './claims.js';
import { coverageRoutes } from './coverage.js';
import { mastersRoutes } from './masters.js';
import { INSURANCE_PERMISSIONS } from './permissions.js';
import { INSURANCE_SCHEMAS } from './schemas.js';
import { splitRoutes } from './split.js';
import { subscribeToPayerReceipts } from './split-receipts.js';
import { SPLIT_INVOICE_SCHEMAS, splitInvoiceRoutes } from './split-invoices.js';

/**
 * Insurance (BE-28, #187), first slice behind the `insurance` switch: the payers (insurers, TPAs,
 * corporates) with their plans and rate agreements, a patient's policies and pre-authorizations.
 * Claims, split billing and corporate credit follow (`CLAUDE.md` in this folder).
 */
export const insuranceFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('insurance', INSURANCE_PERMISSIONS);
  for (const schema of [
    ...INSURANCE_SCHEMAS,
    ...CLAIM_SCHEMAS,
    ...CREDIT_SCHEMAS,
    ...CLAIM_EXPORT_SCHEMAS,
    ...CLAIM_FILE_SCHEMAS,
    ...SPLIT_INVOICE_SCHEMAS,
  ])
    app.addSchema(schema);
  await app.register(mastersRoutes);
  await app.register(coverageRoutes);
  await app.register(splitRoutes);
  await app.register(splitInvoiceRoutes);
  await app.register(claimRoutes);
  await app.register(claimExportRoutes);
  await app.register(claimFileRoutes);
  await app.register(creditRoutes);
  subscribeToPayerReceipts(app);
};
