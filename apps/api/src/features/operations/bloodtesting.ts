import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientFamily } from '../../core/patient-merge/family.js';
import { isCompatible } from './bloodcompat.js';
import { find, UNIT_SELECT, view, type UnitRow } from './bloodbank.js';
import { discardUnits, unscreenedUnitIdsOfDonor } from './bloodhold.js';
import {
  BloodCrossmatch,
  BloodCrossmatchCreate,
  BloodScreening,
  BloodScreeningCreate,
  BloodUnitParams,
  CompatibleUnits,
  CompatibleUnitsRequest,
  PatientBloodGroup,
  PatientBloodGroupSet,
  PatientParams,
} from './schemas.js';
import { isCode, iso, requirePatient, userIdOf } from './util.js';

const FEATURE = 'bloodbank';
const READ = 'bloodUnit:read';
const TEST = 'bloodUnit:test';
const GROUP_READ = 'patient.bloodGroup:read';
const GROUP_UPDATE = 'patient.bloodGroup:update';

const notFound = () => new HttpError(404, 'blood_unit_not_found', 'No such blood unit');

interface GroupRow {
  patient_id: string;
  blood_group: PatientBloodGroup['history'][number]['bloodGroup'];
  reason: string | null;
  recorded_by: string;
  recorded_at: Date;
}

async function groupHistory(client: pg.ClientBase, patientId: string): Promise<GroupRow[]> {
  const { rows } = await client.query<GroupRow>(
    `select patient_id, blood_group, reason, recorded_by, recorded_at from patient_blood_groups
     where patient_id = any($1::uuid[]) order by recorded_at desc, id desc limit 50`,
    // The records merged into this patient count too (#936): their entries stay where they were
    // written (the table is append-only) and are read through the survivor.
    [await patientFamily(client, patientId)],
  );
  return rows;
}

const groupView = (patientId: string, rows: GroupRow[]): PatientBloodGroup => ({
  patientId,
  ...(rows[0] ? { bloodGroup: rows[0].blood_group } : {}),
  history: rows.map((row) => ({
    bloodGroup: row.blood_group,
    ...(row.reason === null ? {} : { reason: row.reason }),
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
    ...(row.patient_id === patientId ? {} : { fromPatientId: row.patient_id }),
  })),
});

interface CrossmatchRow {
  id: string;
  blood_unit_id: string;
  patient_id: string;
  result: BloodCrossmatch['result'];
  performed_by: string;
  performed_at: Date;
  valid_until: Date;
  valid: boolean;
}
const crossmatchView = (row: CrossmatchRow): BloodCrossmatch => ({
  id: row.id,
  unitId: row.blood_unit_id,
  patientId: row.patient_id,
  result: row.result,
  performedBy: row.performed_by,
  performedAt: iso(row.performed_at),
  validUntil: iso(row.valid_until),
});

export const bloodTestingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/blood-units/:unitId/screening',
    {
      config: { permissions: [TEST], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'screenBloodUnit',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Records the infection screening of a unit in testing (409 `not_in_testing`), once (409 `already_screened`): HIV, hepatitis B and C, syphilis and malaria, each negative or reactive. All negative clears the unit, which can then be moved to available. Any reactive result discards the unit (history reason "Reactive screening") and defers its donor for good, in the same transaction; the donor’s other units still collected or in testing are discarded too (reason "Donor had a reactive screening"). Audited; emits `blood.unit_screened` (the outcome only), and for a reactive one `blood.unit_status_changed` and `blood.donor_deferred`. Requires bloodUnit:test.',
        params: BloodUnitParams,
        body: BloodScreeningCreate,
        response: { 201: ref(BloodScreening), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await find(client, request.params.unitId);
      if (!probe) throw notFound();
      const unit = (await find(client, probe.id, true)) as UnitRow;
      if (unit.status !== 'testing') {
        throw new HttpError(409, 'not_in_testing', 'A unit is screened while it is in testing');
      }
      const actor = userIdOf(request);
      let id: string;
      let outcome: 'cleared' | 'reactive';
      let screenedAt: Date;
      try {
        const { rows } = await client.query<{
          id: string;
          outcome: 'cleared' | 'reactive';
          screened_at: Date;
        }>(
          `insert into blood_screenings (blood_unit_id, hiv, hbv, hcv, syphilis, malaria, screened_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id, outcome, screened_at`,
          [unit.id, body.hiv, body.hbv, body.hcv, body.syphilis, body.malaria, actor],
        );
        const row = rows[0] as (typeof rows)[number];
        ({ id, outcome, screened_at: screenedAt } = row);
      } catch (error) {
        if (isCode(error, '23505', 'blood_screenings_once')) {
          throw new HttpError(409, 'already_screened', 'The unit has been screened');
        }
        throw error;
      }
      request.audit('create', 'blood_screening', id);
      await request.emit('blood.unit_screened', unit.id, { outcome });
      if (outcome === 'reactive') {
        await client.query("update blood_units set status = 'discarded' where id = $1", [unit.id]);
        await client.query(
          `insert into blood_unit_events (blood_unit_id, from_status, to_status, reason, actor_id)
           values ($1, 'testing', 'discarded', 'Reactive screening', $2)`,
          [unit.id, actor],
        );
        request.audit('update', 'blood_unit', unit.id);
        await request.emit('blood.unit_status_changed', unit.id, {
          from: 'testing',
          to: 'discarded',
          patientId: null,
          bloodGroup: unit.blood_group,
          component: unit.component,
          encounterId: null,
          serviceId: null,
        });
        const { rows: donor } = await client.query<{ donor_id: string | null }>(
          'select donor_id from blood_units where id = $1',
          [unit.id],
        );
        const donorId = donor[0]?.donor_id ?? null;
        if (donorId !== null) {
          const { rowCount } = await client.query(
            `update blood_donors set deferred_permanent = true, deferred_until = null,
                    deferral_reason = 'Reactive screening'
             where id = $1 and not deferred_permanent`,
            [donorId],
          );
          if (rowCount) {
            request.audit('update', 'blood_donor', donorId);
            await request.emit('blood.donor_deferred', donorId, { permanent: true, until: null });
          }
          // Its other units still waiting for a result are not trusted either.
          await discardUnits(
            request,
            await unscreenedUnitIdsOfDonor(request, donorId, unit.id),
            'Donor had a reactive screening',
          );
        }
      }
      return reply.status(201).send({
        id,
        unitId: unit.id,
        ...body,
        outcome,
        screenedBy: actor,
        screenedAt: iso(screenedAt),
      });
    },
  );

  app.get(
    '/blood-units/:unitId/screening',
    {
      config: { permissions: [TEST], feature: FEATURE },
      schema: {
        operationId: 'getBloodUnitScreening',
        tags: ['bloodbank'],
        description:
          'The screening of a unit, with each test. Audited as a read. 404 `blood_unit_not_found`, or `blood_screening_not_found` before it is screened. Requires bloodUnit:test.',
        params: BloodUnitParams,
        response: { 200: ref(BloodScreening), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const unit = await find(request.txClient, request.params.unitId);
      if (!unit) throw notFound();
      const { rows } = await request.txClient.query<{
        id: string;
        hiv: 'negative' | 'reactive';
        hbv: 'negative' | 'reactive';
        hcv: 'negative' | 'reactive';
        syphilis: 'negative' | 'reactive';
        malaria: 'negative' | 'reactive';
        outcome: 'cleared' | 'reactive';
        screened_by: string;
        screened_at: Date;
      }>(
        `select id, hiv, hbv, hcv, syphilis, malaria, outcome, screened_by, screened_at
         from blood_screenings where blood_unit_id = $1`,
        [unit.id],
      );
      const row = rows[0];
      if (!row) throw new HttpError(404, 'blood_screening_not_found', 'The unit is not screened');
      request.audit('read', 'blood_screening', row.id);
      return {
        id: row.id,
        unitId: unit.id,
        hiv: row.hiv,
        hbv: row.hbv,
        hcv: row.hcv,
        syphilis: row.syphilis,
        malaria: row.malaria,
        outcome: row.outcome,
        screenedBy: row.screened_by,
        screenedAt: iso(row.screened_at),
      };
    },
  );

  app.post(
    '/blood-units/:unitId/crossmatch',
    {
      config: { permissions: [TEST], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'crossmatchBloodUnit',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Records the cross-match of an available unit against a patient (422 `unknown_patient`), good for 72 hours. The patient’s blood group must be on record (422 `blood_group_unknown`), and a compatible result for a group that can never match is refused (422 `abo_incompatible`). A unit past its date is 409 `unit_expired`; one not available is 409 `not_available`. Reserving the unit for the patient needs a compatible cross-match of the last 72 hours. Audited; emits `blood.crossmatch_recorded`. Requires bloodUnit:test.',
        params: BloodUnitParams,
        body: BloodCrossmatchCreate,
        response: { 201: ref(BloodCrossmatch), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await find(client, request.params.unitId);
      if (!probe) throw notFound();
      const unit = (await find(client, probe.id, true)) as UnitRow;
      if (unit.status !== 'available') {
        throw new HttpError(409, 'not_available', 'Only an available unit is cross-matched');
      }
      if (unit.expired) throw new HttpError(409, 'unit_expired', 'The unit is past its date');
      await requirePatient(request, body.patientId);
      const history = await groupHistory(client, body.patientId);
      const current = history[0];
      if (!current) {
        throw new HttpError(422, 'blood_group_unknown', 'Record the patient’s blood group first');
      }
      if (
        body.result === 'compatible' &&
        !isCompatible(unit.blood_group, current.blood_group, unit.component)
      ) {
        throw new HttpError(
          422,
          'abo_incompatible',
          'The unit’s blood group cannot be given to this patient',
        );
      }
      const { rows } = await client.query<CrossmatchRow>(
        `insert into blood_crossmatches (blood_unit_id, patient_id, result, performed_by)
         values ($1, $2, $3, $4)
         returning id, blood_unit_id, patient_id, result, performed_by, performed_at, valid_until,
                   (valid_until > now()) as valid`,
        [unit.id, body.patientId, body.result, userIdOf(request)],
      );
      const row = rows[0] as CrossmatchRow;
      request.audit('create', 'blood_crossmatch', row.id);
      await request.emit('blood.crossmatch_recorded', row.id, {
        unitId: unit.id,
        patientId: body.patientId,
        result: body.result,
      });
      return reply.status(201).send(crossmatchView(row));
    },
  );

  app.get(
    '/patients/:patientId/blood-group',
    {
      config: { permissions: [GROUP_READ], feature: FEATURE },
      schema: {
        operationId: 'getPatientBloodGroup',
        tags: ['bloodbank'],
        description:
          'The patient’s blood group on record and every entry before it, newest first. Audited as a read. 422 `unknown_patient` for a patient the caller may not read. Requires patient.bloodGroup:read.',
        params: PatientParams,
        response: { 200: ref(PatientBloodGroup), ...errors(401, 403, 422, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      await requirePatient(request, patientId);
      request.audit('read', 'patient_blood_group', patientId);
      return groupView(patientId, await groupHistory(request.txClient, patientId));
    },
  );

  app.post(
    '/patients/:patientId/blood-group',
    {
      config: { permissions: [GROUP_UPDATE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'setPatientBloodGroup',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Records the patient’s blood group as a new entry; earlier entries are kept. A group that differs from the one on record needs a `reason` (422 `reason_required`); the same group again changes nothing. Audited. Requires patient.bloodGroup:update.',
        params: PatientParams,
        body: PatientBloodGroupSet,
        response: { 200: ref(PatientBloodGroup), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const body = request.body;
      const client = request.txClient;
      await requirePatient(request, patientId);
      // Two people recording at once see each other: the patient row is the lock.
      await client.query('select 1 from patients where id::text = $1 for update', [patientId]);
      const history = await groupHistory(client, patientId);
      const current = history[0];
      if (current?.blood_group === body.bloodGroup) return groupView(patientId, history);
      if (current && body.reason === undefined) {
        throw new HttpError(422, 'reason_required', 'Say why the blood group is changed');
      }
      await client.query(
        `insert into patient_blood_groups (patient_id, blood_group, reason, recorded_by)
         values ($1, $2, $3, $4)`,
        [patientId, body.bloodGroup, current ? (body.reason ?? null) : null, userIdOf(request)],
      );
      request.audit('update', 'patient_blood_group', patientId);
      return groupView(patientId, await groupHistory(client, patientId));
    },
  );

  app.post(
    '/blood/compatible-units',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listCompatibleBloodUnits',
        tags: ['bloodbank'],
        description:
          'The available units of one component, within their date, whose group can be given to the patient, soonest expiry first (at most 100), each with the latest cross-match for the patient and whether it is still valid. The patient travels in the body, not the address. 422 `unknown_patient`, or `blood_group_unknown` when no group is on record. It reads data only; audited as a read of the patient’s blood group. `patientBloodGroup` is left out unless the caller holds patient.bloodGroup:read. Requires bloodUnit:read.',
        body: ref(CompatibleUnitsRequest),
        response: { 200: ref(CompatibleUnits), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as CompatibleUnitsRequest;
      const client = request.txClient;
      await requirePatient(request, body.patientId);
      const current = (await groupHistory(client, body.patientId))[0];
      if (!current) {
        throw new HttpError(422, 'blood_group_unknown', 'Record the patient’s blood group first');
      }
      request.audit('read', 'patient_blood_group', body.patientId);
      // The group is a field of its own permission: the units are still listed without it.
      const seesGroup =
        (await request.access.policy())?.permissions.some(
          (held) => held.permission === GROUP_READ,
        ) === true;
      const { rows } = await client.query<UnitRow>(
        `${UNIT_SELECT} where x.status = 'available' and x.expires_at > now() and x.component = $1
         order by x.expires_at, x.id`,
        [body.component],
      );
      const fits = rows
        .filter((row) => isCompatible(row.blood_group, current.blood_group, row.component))
        .slice(0, 100);
      const matches = new Map<string, CrossmatchRow>();
      if (fits.length > 0) {
        const { rows: found } = await client.query<CrossmatchRow>(
          `select distinct on (blood_unit_id) id, blood_unit_id, patient_id, result, performed_by,
                  performed_at, valid_until, (result = 'compatible' and valid_until > now()) as valid
           from blood_crossmatches
           where patient_id = any($1::uuid[]) and blood_unit_id = any($2::uuid[])
           order by blood_unit_id, performed_at desc, id desc`,
          [await patientFamily(client, body.patientId), fits.map((row) => row.id)],
        );
        for (const match of found) matches.set(match.blood_unit_id, match);
      }
      return {
        ...(seesGroup ? { patientBloodGroup: current.blood_group } : {}),
        items: fits.map((row) => {
          const match = matches.get(row.id);
          return {
            unit: view(row),
            ...(match ? { crossmatch: crossmatchView(match) } : {}),
            crossmatchValid: match?.valid === true,
          };
        }),
      };
    },
  );
};
