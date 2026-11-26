import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { credentialsOf } from '../doctors/index.js';
import { todaysToken } from '../queue/index.js';
import { FEATURE, visibilityFor } from './http.js';
import { OpdSheet, OpdSheetParams } from './schemas.js';

const PRINT = 'opdSheet:print';
const QUEUE_READ = 'queue:read';

/**
 * The paper OPD sheet of a queue token (#1201): what goes at its head, and an audit entry for the
 * print. The doctor writes the rest by hand, so nothing is stored.
 */
export const opdSheetRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/queue/tokens/:tokenId/opd-sheet',
    {
      config: {
        feature: FEATURE,
        permissions: [QUEUE_READ, PRINT],
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printOpdSheet',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that the blank OPD sheet of one of today’s queue tokens is printed (audit action `print`, entity `queue_token`) and answers what goes at its head. The Idempotency-Key header is required, one per press: a repeat records no further print. A token of another day, another hospital or outside the scope of opdSheet:print is 404 `token_not_found`; a cancelled one is 409 `not_printable`. Requires queue:read and opdSheet:print, within the scope of both, and the clinical and queue feature flags.',
        params: OpdSheetParams,
        response: { 200: ref(OpdSheet), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const policy = await request.access.policy();
      if (policy?.features.queue !== true) {
        throw new HttpError(403, 'feature_disabled', 'The queue is not switched on');
      }
      const reached = (permission: typeof QUEUE_READ | typeof PRINT) =>
        todaysToken(request.txClient, request.params.tokenId, visibilityFor(request, permission));
      // Within the scope of both permissions.
      const token = (await reached(QUEUE_READ)) && (await reached(PRINT));
      if (!token) throw new HttpError(404, 'token_not_found', 'No such token today');
      if (token.status === 'cancelled') {
        throw new HttpError(409, 'not_printable', 'A cancelled token is not printed');
      }
      request.audit(request.replayOf === null ? 'print' : 'read', 'queue_token', token.id);
      const credentials = token.doctor_id
        ? (await credentialsOf(request.txClient, 'doctor', [token.doctor_id])).get(token.doctor_id)
        : undefined;
      return {
        tokenNumber: token.number,
        day: token.day,
        patientName: token.patient_name,
        patientMrn: token.patient_mrn,
        departmentName: token.department_name,
        ...(token.doctor_name ? { doctorName: token.doctor_name } : {}),
        ...(credentials ? { doctorCredentials: credentials } : {}),
      };
    },
  );
};
