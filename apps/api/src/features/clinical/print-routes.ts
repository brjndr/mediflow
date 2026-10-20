import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { encounterFor, FEATURE } from './http.js';
import { findPrescription, ordersOfPrescriptions } from './repository.js';
import { EncounterParams, PrescriptionParams } from './schemas.js';

const PRINT = 'encounter:print';
const READ = 'encounter:read';
const PRESCRIPTION_READ = 'prescription:read';

const prescriptionNotFound = () =>
  new HttpError(404, 'prescription_not_found', 'No such prescription');

const notPrintable = (message: string) => new HttpError(409, 'not_printable', message);

const RECORD =
  ' Records the print in the audit log and nothing else: the web app makes the page from what it has read, and opens the browser’s print dialog only once this answers. The Idempotency-Key header is required, one per press: a repeat records nothing more. One of another hospital, or outside the scope the caller holds the route’s permissions with, is 404 as one that does not exist.';

const recorded = {
  204: Type.Null({ description: 'Recorded' }),
  ...errors(401, 403, 404, 409, 429),
};

/** Printing a prescription or the visit summary: an audit entry per print, for `encounter:print`. */
export const printRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const config = {
    feature: FEATURE,
    idempotent: { body: 'none', required: true },
  } as const;

  app.post(
    '/encounters/:encounterId/print',
    {
      config: { ...config, permissions: [READ, PRINT] },
      schema: {
        operationId: 'printEncounterSummary',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that the visit summary of an encounter is printed (audit action `print`, entity `encounter`). A cancelled encounter is not printed (409 `not_printable`). Requires encounter:read, encounter:print and the clinical feature flag.' +
          RECORD,
        params: EncounterParams,
        response: recorded,
      },
    },
    async (request, reply) => {
      // Within the scope of both permissions.
      await encounterFor(request, request.params.encounterId, READ);
      const encounter = await encounterFor(request, request.params.encounterId, PRINT);
      if (encounter.status === 'cancelled')
        throw notPrintable('A cancelled encounter is not printed');
      if (request.replayOf === null) request.audit('print', 'encounter', encounter.id);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/prescriptions/:prescriptionId/print',
    {
      config: { ...config, permissions: [PRESCRIPTION_READ, PRINT] },
      schema: {
        operationId: 'printPrescription',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that a prescription is printed (audit action `print`, entity `prescription`). One replaced by a revision, or with every line cancelled, is not given to the patient (409 `not_printable`). Requires prescription:read, encounter:print and the clinical feature flag.' +
          RECORD,
        params: PrescriptionParams,
        response: recorded,
      },
    },
    async (request, reply) => {
      const row = await findPrescription(request.txClient, request.params.prescriptionId);
      if (!row) throw prescriptionNotFound();
      try {
        // Within the scope of both permissions.
        await encounterFor(request, row.encounter_id, PRESCRIPTION_READ);
        await encounterFor(request, row.encounter_id, PRINT);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'encounter_not_found') {
          throw prescriptionNotFound();
        }
        throw error;
      }
      const lines = await ordersOfPrescriptions(request.txClient, [row.id]);
      if (row.replaced_by_id || lines.every((line) => line.status === 'cancelled')) {
        throw notPrintable('A replaced or wholly cancelled prescription is not printed');
      }
      if (request.replayOf === null) request.audit('print', 'prescription', row.id);
      return reply.status(204).send(null);
    },
  );
};
