import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientInScope } from '../patients/index.js';
import { bedForAdmission, lockWard } from '../wards/index.js';
import { activeAdmissionOf, boardBed, refusedBy } from './repository.js';
import {
  insertReservation,
  liveReservationOfBed,
  releaseReservation,
  reservationPlace,
  sweepExpired,
} from './reservation-repo.js';
import { announce, boardView, grantOf, requireWards, userIdOf } from './routes.js';
import {
  ADMISSION_SCHEMAS,
  BedParams,
  BedReservationCreate,
  BoardBed,
  RESERVATION_MAX_DAYS,
  RESERVATION_NOTE_MAX,
  ReservationParams,
} from './schemas.js';

/**
 * Bed reservations (#582): a bed held for a patient not in it yet, until a time. Checked in code
 * under the ward's lock, with a unique index on the open reservations as the backstop; the
 * places that give a bed (`claimBed`) refuse a bed held for someone else.
 */
const FEATURE = 'admissions';
const RESERVE = 'bed:reserve';
const READ = 'admission:read';
const DAY_MS = 86_400_000;

export const reservationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of ADMISSION_SCHEMAS) app.addSchema(schema);

  const config = {
    permissions: [RESERVE, READ],
    feature: FEATURE,
    idempotent: { body: 'none', required: true },
  } as const;

  app.post(
    '/beds/:bedId/reservations',
    {
      config,
      schema: {
        operationId: 'reserveBed',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description: `Holds a bed for a patient not in it yet, until \`expiresAt\` (in the future, within ${RESERVATION_MAX_DAYS} days: 422 \`invalid_expiry\`). A bed has one reservation at a time (409 \`bed_reserved\`) and a patient one (409 \`patient_has_reservation\`); an archived or blocked bed is 409 \`bed_not_available\`, a patient already admitted 409 \`already_admitted\`. Until it ends, giving the bed to another patient is 409 \`bed_reserved\`; giving it to this one fulfils it, and it lapses by itself at its time. 404 \`bed_not_found\`; 422 \`unknown_patient\`. Needs the wards module. The Idempotency-Key header is required. Audited, announced on \`/beds/events\`, emits \`bed.reserved\` (ids only). Requires bed:reserve and admission:read, and patient:read within its scope.`,
        params: BedParams,
        body: BedReservationCreate,
        response: { 201: ref(BoardBed), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      await requireWards(request);
      const client = request.txClient;
      const { bedId } = request.params;
      if (request.replayOf === null) {
        const body = request.body;
        const userId = userIdOf(request);
        const patientScope = await grantOf(request, 'patient:read', 'patients');
        if (
          patientScope === null ||
          !(await patientInScope(client, body.patientId, { scope: patientScope, userId }))
        ) {
          throw new HttpError(422, 'unknown_patient', 'No such patient');
        }
        const expires = Date.parse(body.expiresAt);
        const now = Date.now();
        if (!(expires > now) || expires - now > RESERVATION_MAX_DAYS * DAY_MS) {
          throw new HttpError(422, 'invalid_expiry', 'The hold must end in the future, soon');
        }
        const probe = await bedForAdmission(client, bedId);
        if (!probe) throw new HttpError(404, 'bed_not_found', 'No such bed');
        await lockWard(client, probe.ward_id);
        const bed = await bedForAdmission(client, bedId);
        if (!bed || bed.archived || bed.status === 'blocked') {
          throw new HttpError(409, 'bed_not_available', 'The bed is not available');
        }
        await sweepExpired(client, { bedId });
        await sweepExpired(client, { patientId: body.patientId });
        if ((await liveReservationOfBed(client, bedId)) !== null) {
          throw new HttpError(409, 'bed_reserved', 'The bed is already reserved');
        }
        if ((await activeAdmissionOf(client, body.patientId)) !== null) {
          throw new HttpError(409, 'already_admitted', 'The patient is already admitted');
        }
        const note = body.note === undefined ? '' : tidyWithin(body.note, RESERVATION_NOTE_MAX);
        let id: string;
        try {
          id = await insertReservation(
            client,
            {
              patientId: body.patientId,
              bedId,
              wardId: bed.ward_id,
              expiresAt: new Date(expires).toISOString(),
              ...(note === '' ? {} : { note }),
            },
            userId,
          );
        } catch (error) {
          if (refusedBy(error, '23505', 'bed_reservations_one_per_patient')) {
            throw new HttpError(409, 'patient_has_reservation', 'The patient holds another bed');
          }
          if (refusedBy(error, '23505', 'bed_reservations_one_per_bed')) {
            throw new HttpError(409, 'bed_reserved', 'The bed is already reserved');
          }
          throw error;
        }
        request.audit('create', 'bed_reservation', id);
        announce(request, bed.ward_id);
        await request.emit('bed.reserved', bedId, {
          reservationId: id,
          patientId: body.patientId,
          bedId,
          wardId: bed.ward_id,
        });
      }
      const now = await boardBed(client, bedId);
      if (!now) throw new HttpError(404, 'bed_not_found', 'No such bed');
      const view = boardView(now);
      if (view.reservation) request.audit('read', 'patient', view.reservation.patientId);
      return reply.status(201).send(view);
    },
  );

  app.post(
    '/bed-reservations/:reservationId/cancel',
    {
      config,
      schema: {
        operationId: 'cancelBedReservation',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Lets a hold on a bed go, so anyone may be given it. 404 `reservation_not_found`; 409 `reservation_ended` when it already ended (fulfilled, cancelled or lapsed). Needs the wards module. The Idempotency-Key header is required. Audited, announced on `/beds/events`, emits `bed.reservation_ended`. Requires bed:reserve and admission:read.',
        params: ReservationParams,
        response: { 200: ref(BoardBed), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      await requireWards(request);
      const client = request.txClient;
      const { reservationId } = request.params;
      const place = await reservationPlace(client, reservationId);
      if (!place) throw new HttpError(404, 'reservation_not_found', 'No such reservation');
      if (request.replayOf === null) {
        await lockWard(client, place.ward_id);
        if (!(await releaseReservation(client, reservationId, 'cancelled', userIdOf(request)))) {
          throw new HttpError(409, 'reservation_ended', 'The reservation has ended');
        }
        request.audit('update', 'bed_reservation', reservationId);
        announce(request, place.ward_id);
        await request.emit('bed.reservation_ended', place.bed_id, {
          reservationId,
          bedId: place.bed_id,
          wardId: place.ward_id,
          reason: 'cancelled',
        });
      }
      const now = await boardBed(client, place.bed_id);
      if (!now) throw new HttpError(404, 'bed_not_found', 'No such bed');
      return reply.status(200).send(boardView(now));
    },
  );
};
