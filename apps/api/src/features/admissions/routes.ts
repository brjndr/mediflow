import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission, PermissionScope } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  cancelInpatientEncounter,
  closeInpatientEncounter,
  openInpatientEncounter,
} from '../clinical/index.js';
import { ownDoctorId, practisingDoctor } from '../doctors/index.js';
import { patientInScope } from '../patients/index.js';
import {
  bedForAdmission,
  BEDS_TOPIC,
  lockWard,
  moveBed,
  type AdmissionBed,
} from '../wards/index.js';
import {
  activeAdmissionOf,
  boardBed,
  cancelAdmission,
  dischargeAdmission,
  findAdmission,
  insertAdmission,
  insertAssignment,
  listAdmissions,
  listBoard,
  openAssignment,
  refusedBy,
  releaseAssignment,
  staysOf,
  touchAdmission,
  type AdmissionFilter,
  type AdmissionRow,
  type BoardRow,
  type Visibility,
} from './repository.js';
import type { Admission } from './schemas.js';
import {
  type BoardBedStatusValue,
  ADMISSION_SCHEMAS,
  AdmissionBedChange,
  AdmissionCancel,
  AdmissionCreate,
  AdmissionDetail,
  AdmissionDischarge,
  AdmissionListQuery,
  AdmissionPage,
  AdmissionParams,
  BedHousekeeping,
  BedParams,
  BoardBed,
  BoardBedPage,
  BoardQuery,
  CANCEL_REASON_MAX,
  MOVE_NOTE_MAX,
  type MoveReasonValue,
} from './schemas.js';

const FEATURE = 'admissions';
const READ = 'admission:read';
const CREATE = 'admission:create';
const TRANSFER = 'admission:transfer';
const DISCHARGE = 'admission:discharge';
const CANCEL = 'admission:cancel';
const BED_UPDATE = 'bed:update';

const notFound = () => new HttpError(404, 'admission_not_found', 'No such admission');
const unavailable = () => new HttpError(409, 'bed_not_available', 'The bed is not available');

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const visibilityFor = (request: FastifyRequest, permission: Permission): Visibility => ({
  scope: request.access.scope(permission),
  userId: userIdOf(request),
});

/** What the caller holds a permission of another module with, or null when it is off or not held. */
async function grantOf(
  request: FastifyRequest,
  permission: string,
  feature: string,
): Promise<PermissionScope | null> {
  const policy = await request.access.policy();
  if (policy?.features[feature] !== true) return null;
  const grant = policy.permissions.find((held) => held.permission === permission);
  return grant ? (grant.scope ?? 'all') : null;
}

/** The beds are the wards module's: a hospital with it off has no bed to give. */
async function requireWards(request: FastifyRequest): Promise<void> {
  if ((await request.access.policy())?.features.wards !== true) {
    throw new HttpError(403, 'feature_disabled', 'The wards module is off');
  }
}

const iso = (value: Date) => value.toISOString();

const admissionView = (row: AdmissionRow): Admission => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  encounterId: row.encounter_id,
  doctorId: row.doctor_id,
  doctorName: row.doctor_name,
  departmentId: row.department_id,
  departmentName: row.department_name,
  admissionType: row.admission_type,
  status: row.status,
  admittedAt: iso(row.admitted_at),
  ...(row.discharged_at === null ? {} : { dischargedAt: iso(row.discharged_at) }),
  ...(row.discharge_type === null ? {} : { dischargeType: row.discharge_type }),
  ...(row.cancelled_at === null ? {} : { cancelledAt: iso(row.cancelled_at) }),
  ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
  ...(row.advice_note === null ? {} : { adviceNote: row.advice_note }),
  ...(row.attendant_name === null ? {} : { attendantName: row.attendant_name }),
  ...(row.attendant_relation === null ? {} : { attendantRelation: row.attendant_relation }),
  ...(row.attendant_phone === null ? {} : { attendantPhone: row.attendant_phone }),
  ...(row.deposit_minor === null ? {} : { depositMinor: Number(row.deposit_minor) }),
  consents: row.consents,
  ...(row.assignment_id === null ||
  row.bed_id === null ||
  row.assigned_at === null ||
  row.ward_id === null
    ? {}
    : {
        bed: {
          assignmentId: row.assignment_id,
          bedId: row.bed_id,
          bedNumber: row.bed_number ?? '',
          wardId: row.ward_id,
          wardName: row.ward_name ?? '',
          roomName: row.room_name ?? '',
          assignedAt: iso(row.assigned_at),
        },
      }),
  version: row.version,
});

const boardView = (row: BoardRow): BoardBed => ({
  id: row.id,
  number: row.number,
  wardId: row.ward_id,
  wardName: row.ward_name,
  roomId: row.room_id,
  roomName: row.room_name,
  categoryName: row.category_name,
  status: row.status,
  ...(row.blocked_reason === null ? {} : { blockedReason: row.blocked_reason }),
  ...(row.admission_id === null ||
  row.patient_id === null ||
  row.assigned_at === null ||
  row.status !== 'occupied'
    ? {}
    : {
        occupant: {
          admissionId: row.admission_id,
          patientId: row.patient_id,
          patientName: row.patient_name ?? '',
          patientMrn: row.patient_mrn ?? '',
          assignedAt: iso(row.assigned_at),
        },
      }),
  version: row.version,
});

async function detailOf(request: FastifyRequest, row: AdmissionRow) {
  const stays = await staysOf(request.txClient, row.id);
  return {
    admission: admissionView(row),
    stays: stays.map((stay) => ({
      assignmentId: stay.id,
      bedId: stay.bed_id,
      bedNumber: stay.bed_number,
      wardId: stay.ward_id,
      wardName: stay.ward_name,
      bedCategoryId: stay.bed_category_id,
      ...(stay.service_id === null ? {} : { serviceId: stay.service_id }),
      ...(stay.day_price_minor === null ? {} : { dayPriceMinor: Number(stay.day_price_minor) }),
      assignedAt: iso(stay.assigned_at),
      ...(stay.move_reason === null ? {} : { moveReason: stay.move_reason }),
      ...(stay.move_note === null ? {} : { moveNote: stay.move_note }),
      ...(stay.released_at === null ? {} : { releasedAt: iso(stay.released_at) }),
      ...(stay.release_reason === null ? {} : { releaseReason: stay.release_reason }),
    })),
  };
}

/**
 * Locks the wards in id order (so two requests that need the same two wards never wait for each
 * other) and then reads the bed as it is. 422 for a bed this hospital does not have, 409 unless
 * it is available. `alsoWards` are wards the caller must hold as well (the bed being left).
 */
async function claimBed(
  request: FastifyRequest,
  bedId: string,
  alsoWards: string[] = [],
): Promise<AdmissionBed> {
  const client = request.txClient;
  const probe = await bedForAdmission(client, bedId);
  if (!probe) throw new HttpError(422, 'unknown_bed', 'No such bed');
  for (const wardId of [...new Set([probe.ward_id, ...alsoWards])].sort()) {
    await lockWard(client, wardId);
  }
  const bed = await bedForAdmission(client, bedId);
  if (!bed || bed.archived || bed.status !== 'available') throw unavailable();
  return bed;
}

/** Tells the hospital's open boards that a ward's beds changed, once this commits. */
const announce = (request: FastifyRequest, wardId: string) =>
  request.server.live.bus.publish(request.txClient, BEDS_TOPIC, { wardId });

/** Gives the admission the bed `claimBed` returned: the assignment, the status, the event. */
async function placeInBed(
  request: FastifyRequest,
  admission: { id: string; patientId: string },
  bed: AdmissionBed,
  why: { moveReason?: MoveReasonValue; moveNote?: string } = {},
): Promise<void> {
  const client = request.txClient;
  try {
    if (!(await moveBed(client, bed.id, 'available', 'occupied', null))) throw unavailable();
  } catch (error) {
    // The trigger: a bed of an archived ward or room takes no patient.
    if ((error as { code?: unknown } | null)?.code === '23514') throw unavailable();
    throw error;
  }
  let assignmentId: string;
  try {
    assignmentId = await insertAssignment(
      client,
      {
        admissionId: admission.id,
        patientId: admission.patientId,
        bedId: bed.id,
        wardId: bed.ward_id,
        bedCategoryId: bed.bed_category_id,
        serviceId: bed.service_id,
        ...why,
      },
      userIdOf(request),
    );
  } catch (error) {
    // The exclusion constraints, the backstop of the ward's lock.
    if ((error as { code?: unknown } | null)?.code === '23P01') throw unavailable();
    throw error;
  }
  announce(request, bed.ward_id);
  await request.emit('bed.assigned', bed.id, {
    assignmentId,
    admissionId: admission.id,
    patientId: admission.patientId,
    bedId: bed.id,
    wardId: bed.ward_id,
    bedCategoryId: bed.bed_category_id,
    serviceId: bed.service_id,
  });
}

/** Frees the bed a patient leaves: it is being cleaned until housekeeping says it is ready. */
async function leaveBed(
  request: FastifyRequest,
  admission: { id: string; patientId: string },
  reason: 'transfer' | 'discharge' | 'cancelled',
): Promise<void> {
  const released = await releaseAssignment(
    request.txClient,
    admission.id,
    reason,
    userIdOf(request),
  );
  if (!released) return;
  if (
    !(await moveBed(
      request.txClient,
      released.bed_id,
      'occupied',
      // A bed the patient never needed cleaned is ready again at once.
      reason === 'cancelled' ? 'available' : 'cleaning',
      null,
    ))
  ) {
    throw new Error('bed of an open assignment was not occupied');
  }
  announce(request, released.ward_id);
  await request.emit('bed.released', released.bed_id, {
    assignmentId: released.id,
    admissionId: admission.id,
    patientId: admission.patientId,
    bedId: released.bed_id,
    wardId: released.ward_id,
    reason,
  });
}

const CHANGE_RULES =
  ' The `version` must be the current one, or 409 `conflict` (a change of bed counts as a change). An admission outside the scope the caller holds the permission with, or of another hospital, answers 404 `admission_not_found`. The Idempotency-Key header is required: the same key changes nothing again and answers with the admission as it is now. Audited, and announced on `/beds/events`.';

export const admissionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of ADMISSION_SCHEMAS) app.addSchema(schema);

  const changeConfig = (permission: Permission) =>
    ({
      permissions: [permission, READ],
      feature: FEATURE,
      idempotent: { body: 'none', required: true },
    }) as const;

  app.get(
    '/admissions',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listAdmissions',
        tags: ['admissions'],
        description:
          'The hospital’s admissions, newest first: of one status, of one patient, in one ward (the ward of the bed the patient is in now), or any of those together. Ids that are not the hospital’s match nothing. Within the scope the caller holds admission:read with: `own`, the admissions they made as a doctor; `department`, those of their department. A list nobody types patient facts into, so a GET. Every row names its patient, so every row of a page is audited. `total` comes with the first page only. Requires admission:read and the admissions feature flag.',
        querystring: AdmissionListQuery,
        response: { 200: ref(AdmissionPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, ...rest } = request.query;
      const filter = rest as Omit<AdmissionFilter, 'cursor' | 'limit'>;
      const page = await listAdmissions(
        request.txClient,
        { ...filter, ...(cursor === undefined ? {} : { cursor }), limit },
        visibilityFor(request, READ),
      );
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'admission', row.id);
      return {
        items: page.rows.map(admissionView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.get(
    '/admissions/:admissionId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getAdmission',
        tags: ['admissions'],
        description:
          'One admission with the beds the patient has been in, oldest first. 404 `admission_not_found` for one that does not exist, is another hospital’s or is outside the caller’s scope. Audited as a read.',
        params: AdmissionParams,
        response: { 200: ref(AdmissionDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findAdmission(
        request.txClient,
        request.params.admissionId,
        visibilityFor(request, READ),
      );
      if (!row) throw notFound();
      request.audit('read', 'admission', row.id);
      return detailOf(request, row);
    },
  );

  app.post(
    '/admissions',
    {
      config: changeConfig(CREATE),
      schema: {
        operationId: 'admitPatient',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Admits a patient: opens the stay’s inpatient encounter and the admission, and gives the patient a bed when `bedId` is sent (otherwise assignBed does later). A patient has one admission not yet discharged (409 `already_admitted`). The bed must be available (409 `bed_not_available`), is looked up in the hospital only (422 `unknown_bed`), and needs the wards module (403 `feature_disabled`). Of two requests for one bed at the same moment, one succeeds and the other is 409: the ward is locked while a bed is given, and an exclusion constraint on the time a bed holds a patient backs it up. The doctor is `doctorId`, else the caller’s own profile; one who does not practise here, or is outside the scope the caller holds admission:create with, is 422 `unknown_doctor`. Requires admission:create and admission:read, and patient:read (checked in the handler, within its scope): a patient the caller may not read and one that does not exist are both 422 `unknown_patient`. The Idempotency-Key header is required: a repeat admits nobody again and answers with the admission. Audited; emits `encounter.opened`, `admission.created` and, with a bed, `bed.assigned` through the outbox, and is announced on `/beds/events`.',
        body: ref(AdmissionCreate),
        response: { 201: ref(AdmissionDetail), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = userIdOf(request);
      if (request.replayOf !== null) {
        const row = request.idempotentId
          ? await findAdmission(
              request.txClient,
              request.idempotentId,
              visibilityFor(request, READ),
            )
          : null;
        if (!row) throw notFound();
        request.audit('read', 'admission', row.id);
        return reply.status(201).send(await detailOf(request, row));
      }
      const body = request.body as AdmissionCreate;
      const client = request.txClient;

      const patientScope = await grantOf(request, 'patient:read', 'patients');
      if (
        patientScope === null ||
        !(await patientInScope(client, body.patientId, { scope: patientScope, userId }))
      ) {
        throw new HttpError(422, 'unknown_patient', 'No such patient');
      }
      if (
        body.attendantName === undefined &&
        (body.attendantPhone !== undefined || body.attendantRelation !== undefined)
      ) {
        throw new HttpError(422, 'attendant_name_required', 'Name the attendant');
      }
      const doctorId = body.doctorId ?? (await ownDoctorId(client, userId));
      const doctor = doctorId
        ? await practisingDoctor(client, doctorId, visibilityFor(request, CREATE))
        : null;
      if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');

      let bed: AdmissionBed | null = null;
      if (body.bedId !== undefined) {
        await requireWards(request);
        bed = await claimBed(request, body.bedId);
      }
      if ((await activeAdmissionOf(client, body.patientId)) !== null) {
        throw new HttpError(409, 'already_admitted', 'The patient is already admitted');
      }

      const encounterId = await openInpatientEncounter(
        client,
        { patientId: body.patientId, doctorId: doctor.id, departmentId: doctor.department_id },
        userId,
      );
      let id: string;
      try {
        id = await insertAdmission(
          client,
          {
            patientId: body.patientId,
            encounterId,
            doctorId: doctor.id,
            departmentId: doctor.department_id,
            admissionType: body.admissionType,
            ...(body.adviceNote === undefined ? {} : { adviceNote: body.adviceNote }),
            ...(body.attendantName === undefined ? {} : { attendantName: body.attendantName }),
            ...(body.attendantRelation === undefined
              ? {}
              : { attendantRelation: body.attendantRelation }),
            ...(body.attendantPhone === undefined ? {} : { attendantPhone: body.attendantPhone }),
            ...(body.depositMinor === undefined ? {} : { depositMinor: body.depositMinor }),
            ...(body.consents === undefined ? {} : { consents: body.consents }),
          },
          userId,
        );
      } catch (error) {
        if (refusedBy(error, '23505', 'admissions_one_active')) {
          throw new HttpError(409, 'already_admitted', 'The patient is already admitted');
        }
        throw error;
      }
      request.idempotentId = id;
      request.audit('create', 'admission', id);
      await request.emit('encounter.opened', encounterId, {
        encounterId,
        patientId: body.patientId,
        type: 'ipd',
        doctorId: doctor.id,
        departmentId: doctor.department_id,
      });
      await request.emit('admission.created', id, {
        admissionId: id,
        patientId: body.patientId,
        encounterId,
        doctorId: doctor.id,
        departmentId: doctor.department_id,
        admissionType: body.admissionType,
      });
      if (bed) await placeInBed(request, { id, patientId: body.patientId }, bed);

      const created = await findAdmission(client, id, { scope: 'all', userId });
      if (!created) throw new Error('admission was not created');
      return reply.status(201).send(await detailOf(request, created));
    },
  );

  /** A change of the admission: at the version it started from, and while it is admitted. */
  async function changeAdmission(
    request: FastifyRequest<{ Params: { admissionId: string } }>,
    reply: FastifyReply,
    permission: Permission,
    version: number,
    change: (row: AdmissionRow) => Promise<void>,
  ) {
    const visibility = visibilityFor(request, permission);
    const id = request.params.admissionId;
    if (request.replayOf === null) {
      const row = await findAdmission(request.txClient, id, visibility, { forUpdate: true });
      if (!row) throw notFound();
      if (row.version !== version) {
        throw new HttpError(409, 'conflict', 'The admission has changed since it was read');
      }
      if (row.status !== 'admitted') {
        throw new HttpError(409, 'invalid_transition', `The admission is ${row.status}`);
      }
      await change(row);
      request.audit('update', 'admission', row.id);
    }
    const now = await findAdmission(request.txClient, id, visibility);
    if (!now) throw notFound();
    if (request.replayOf !== null) request.audit('read', 'admission', now.id);
    return reply.status(200).send(await detailOf(request, now));
  }

  for (const mode of ['assign', 'transfer'] as const) {
    app.post(
      mode === 'assign'
        ? '/admissions/:admissionId/assign-bed'
        : '/admissions/:admissionId/transfer',
      {
        config: changeConfig(TRANSFER),
        schema: {
          operationId: mode === 'assign' ? 'assignBed' : 'transferPatient',
          tags: ['admissions'],
          headers: RequiredIdempotencyHeaders,
          description:
            (mode === 'assign'
              ? 'Gives an admitted patient who has no bed an available one (409 `already_in_bed` for one who has: use transferPatient).'
              : 'Moves an admitted patient from their bed to another available one (409 `no_bed` for one who has none: use assignBed; 422 `same_bed`). The bed they leave is set to being cleaned, with `bed.released` and `bed.assigned` through the outbox, and the move is one transaction: the patient is never in no bed or two.') +
            ' The target must be available (409 `bed_not_available`), is looked up in the hospital only (422 `unknown_bed`) and needs the wards module (403 `feature_disabled`). Both wards are locked, in id order, while the move is made. Requires admission:transfer and admission:read.' +
            CHANGE_RULES,
          params: AdmissionParams,
          body: AdmissionBedChange,
          response: { 200: ref(AdmissionDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
        },
      },
      async (request, reply) => {
        const body = request.body as AdmissionBedChange;
        return changeAdmission(request, reply, TRANSFER, body.version, async (row) => {
          await requireWards(request);
          const current = await openAssignment(request.txClient, row.id);
          if (mode === 'assign' && current) {
            throw new HttpError(409, 'already_in_bed', 'The patient has a bed already');
          }
          if (mode === 'transfer' && !current) {
            throw new HttpError(409, 'no_bed', 'The patient has no bed to leave');
          }
          if (current && current.bed_id === body.bedId) {
            throw new HttpError(422, 'same_bed', 'The patient is in that bed already');
          }
          if (body.note !== undefined && body.reason === undefined) {
            throw new HttpError(400, 'validation_failed', 'A note needs a reason');
          }
          const note = body.note === undefined ? '' : tidyWithin(body.note, MOVE_NOTE_MAX);
          const bed = await claimBed(request, body.bedId, current ? [current.ward_id] : []);
          const admission = { id: row.id, patientId: row.patient_id };
          await leaveBed(request, admission, 'transfer');
          await placeInBed(request, admission, bed, {
            ...(body.reason === undefined ? {} : { moveReason: body.reason }),
            ...(note === '' ? {} : { moveNote: note }),
          });
          await touchAdmission(request.txClient, row.id);
        });
      },
    );
  }

  app.post(
    '/admissions/:admissionId/discharge',
    {
      config: changeConfig(DISCHARGE),
      schema: {
        operationId: 'dischargePatient',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Discharges an admitted patient: the stay’s inpatient encounter is closed (409 `unsigned_notes` while a note of it is a draft, and nothing changes), the bed is set to being cleaned and the admission is final. Emits `encounter.closed`, `bed.released` and `discharge.completed` through the outbox. Billing and the discharge summary react to the event; this API does not clear the bill. Requires admission:discharge and admission:read.' +
          CHANGE_RULES,
        params: AdmissionParams,
        body: AdmissionDischarge,
        response: { 200: ref(AdmissionDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as AdmissionDischarge;
      return changeAdmission(request, reply, DISCHARGE, body.version, async (row) => {
        const client = request.txClient;
        const admission = { id: row.id, patientId: row.patient_id };
        const closed = await closeInpatientEncounter(client, row.encounter_id, userIdOf(request));
        if (closed === 'unsigned_notes') {
          throw new HttpError(409, 'unsigned_notes', 'A note of the stay is still a draft');
        }
        if (closed === 'not_open') {
          throw new HttpError(409, 'encounter_not_open', 'The stay’s encounter is not open');
        }
        // The admission is held; the ward is taken after it, as everywhere.
        const current = await openAssignment(client, row.id);
        if (current) await lockWard(client, current.ward_id);
        await leaveBed(request, admission, 'discharge');
        await dischargeAdmission(client, row.id, body.dischargeType, userIdOf(request));
        await request.emit('encounter.closed', row.encounter_id, {
          encounterId: row.encounter_id,
          patientId: row.patient_id,
        });
        await request.emit('discharge.completed', row.id, {
          admissionId: row.id,
          patientId: row.patient_id,
          encounterId: row.encounter_id,
          dischargeType: body.dischargeType,
        });
      });
    },
  );

  app.post(
    '/admissions/:admissionId/cancel',
    {
      config: changeConfig(CANCEL),
      schema: {
        operationId: 'cancelAdmission',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels an admission made by mistake, with a reason: the stay’s inpatient encounter is cancelled, the bed it held (if any) is set available again and the admission is final. Only while nothing of the stay is on the record: a signed note, a diagnosis that stands, an order not cancelled or a prescription is 409 `has_records` (discharge the patient instead), and a draft note is 409 `unsigned_notes`. Emits `encounter.cancelled`, `bed.released` (reason `cancelled`) and `admission.cancelled` through the outbox, never the reason. Requires admission:cancel and admission:read.' +
          CHANGE_RULES,
        params: AdmissionParams,
        body: AdmissionCancel,
        response: { 200: ref(AdmissionDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as AdmissionCancel;
      const reason = tidyWithin(body.reason, CANCEL_REASON_MAX);
      if (reason === '') throw new HttpError(400, 'validation_failed', 'A reason is needed');
      return changeAdmission(request, reply, CANCEL, body.version, async (row) => {
        const client = request.txClient;
        const admission = { id: row.id, patientId: row.patient_id };
        const cancelled = await cancelInpatientEncounter(
          client,
          row.encounter_id,
          userIdOf(request),
          reason,
        );
        if (cancelled === 'unsigned_notes') {
          throw new HttpError(409, 'unsigned_notes', 'A note of the stay is still a draft');
        }
        if (cancelled === 'has_records') {
          throw new HttpError(409, 'has_records', 'The stay has records: discharge instead');
        }
        if (cancelled === 'not_open') {
          throw new HttpError(409, 'encounter_not_open', 'The stay’s encounter is not open');
        }
        // The admission is held; the ward is taken after it, as everywhere.
        const current = await openAssignment(client, row.id);
        if (current) await lockWard(client, current.ward_id);
        await leaveBed(request, admission, 'cancelled');
        await cancelAdmission(client, row.id, reason, userIdOf(request));
        await request.emit('encounter.cancelled', row.encounter_id, {
          encounterId: row.encounter_id,
          patientId: row.patient_id,
        });
        await request.emit('admission.cancelled', row.id, {
          admissionId: row.id,
          patientId: row.patient_id,
          encounterId: row.encounter_id,
        });
      });
    },
  );

  app.get(
    '/beds/board',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listBedBoard',
        tags: ['admissions'],
        description:
          'The beds in use (not archived, in a ward and a room not archived) with their status and, for an occupied bed, the patient in it: by ward name and bed number, filtered by ward and status. The board reads this again on each event of `/beds/events`. Names patients, so the admission of every occupied bed of a page is audited as a read. `total` comes with the first page only. Requires admission:read, the admissions and wards feature flags.',
        querystring: BoardQuery,
        response: { 200: ref(BoardBedPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      await requireWards(request);
      const { cursor, limit = DEFAULT_PAGE_SIZE, wardId, status } = request.query;
      const page = await listBoard(request.txClient, {
        ...(wardId === undefined ? {} : { wardId }),
        ...(status === undefined ? {} : { status: status as BoardBedStatusValue }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const items = page.rows.map(boardView);
      for (const item of items) {
        if (item.occupant) request.audit('read', 'admission', item.occupant.admissionId);
      }
      return {
        items,
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/beds/:bedId/housekeeping',
    {
      config: {
        permissions: [BED_UPDATE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setBedHousekeeping',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Marks an available bed being cleaned, or a bed being cleaned ready (available). Only these two moves: an occupied or blocked bed is 409 `invalid_transition` (a patient leaving sets a bed being cleaned by itself; blocking is the wards API). The `version` is the bed’s, from the board, or 409 `conflict`. The ward is locked while the bed changes. 404 `bed_not_found` for a bed this hospital does not have. Needs the wards module (403 `feature_disabled`). The Idempotency-Key header is required. Audited, and announced on `/beds/events`. Requires bed:update.',
        params: BedParams,
        body: BedHousekeeping,
        response: { 200: ref(BoardBed), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      await requireWards(request);
      const client = request.txClient;
      const { bedId } = request.params;
      if (request.replayOf === null) {
        const body = request.body as BedHousekeeping;
        const probe = await bedForAdmission(client, bedId);
        if (!probe) throw new HttpError(404, 'bed_not_found', 'No such bed');
        await lockWard(client, probe.ward_id);
        const bed = await bedForAdmission(client, bedId);
        if (!bed) throw new HttpError(404, 'bed_not_found', 'No such bed');
        if (bed.archived) {
          throw new HttpError(409, 'bed_not_available', 'The bed is archived');
        }
        if (bed.version !== body.version) {
          throw new HttpError(409, 'conflict', 'The bed has changed since it was read');
        }
        const from = body.status === 'cleaning' ? 'available' : 'cleaning';
        if (bed.status !== from || !(await moveBed(client, bed.id, from, body.status, null))) {
          throw new HttpError(409, 'invalid_transition', `Not from ${bed.status}`);
        }
        request.audit('update', 'bed', bed.id);
        announce(request, bed.ward_id);
      }
      const now = await boardBed(client, bedId);
      if (!now) throw new HttpError(404, 'bed_not_found', 'No such bed');
      return reply.status(200).send(boardView(now));
    },
  );

  app.get(
    '/beds/events',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'bedEvents',
        tags: ['admissions'],
        description:
          'Server-sent events for the beds of the session’s hospital, and of no other. Each `beds` event says only which ward changed (`data: {"wardId":"..."}`), never who is in a bed: the board then reads again through listBedBoard, which is audited. The stream opens with a `retry:` line and holds no database connection while open; a comment line is sent every 20 seconds to keep the connection open, and a client takes 45 seconds without anything as a lost connection. The server ends the stream when the session ends, is revoked, goes idle or switches hospital, and when the session loses admission:read or the hospital the admissions switch or is suspended, checking all of these again at each keep-alive and before sending events. It also ends the stream when it may have missed changes, so the board opens it again and reads afresh. 503 `live_unavailable` when live updates cannot be followed now: the board reads on a timer instead. Requires admission:read and the admissions feature flag.',
        produces: ['text/event-stream'],
        response: {
          200: Type.String({ description: 'An event stream that stays open' }),
          ...errors(401, 403, 409, 429, 503),
        },
      },
    },
    async (request, reply) => {
      await app.live.stream(request, reply, {
        topic: BEDS_TOPIC,
        event: 'beds',
        filter: async () => (data) => typeof data.wardId === 'string',
      });
    },
  );
};
