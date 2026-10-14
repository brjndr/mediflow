import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  cleanName,
  componentsFor,
  invalid,
  prepareLabTest,
  serviceFor,
  writeLabTest,
} from './create.js';
import {
  ageBefore,
  ageWithinMax,
  bandForAge,
  bandsOverlap,
  type Age,
  type AgeUnit,
} from './age.js';
import {
  componentsOf,
  findLabTest,
  hasArchivedComponent,
  hasRanges,
  inPanelInUse,
  listRanges,
  lockLabTest,
  replaceComponents,
  replaceRanges,
  searchLabTests,
  setArchived,
  updateLabTest,
  type LabTestDetails,
  type LabTestRow,
} from './repository.js';
import {
  CONTAINER_MAX,
  LAB_TEST_SCHEMAS,
  LabRangeResolved,
  LabRangeResolveQuery,
  LabRanges,
  LabRangesUpdate,
  LabTest,
  LabTestCreate,
  LabTestPage,
  LabTestSearchRequest,
  LabTestUpdate,
  NOTE_MAX,
  UNIT_MAX,
  type LabRange,
  type LabTestComponent,
} from './schemas.js';

const FEATURE = 'lab_tests';
const READ = 'labTest:read';
const MANAGE = 'labTest:manage';

const view = (row: LabTestRow, components: LabTestComponent[] = []): LabTest => ({
  id: row.id,
  tenantId: row.tenant_id,
  code: row.code,
  name: row.name,
  department: row.department,
  kind: row.kind,
  resultType: row.result_type,
  ...(row.unit === null ? {} : { unit: row.unit }),
  sampleType: row.sample_type,
  ...(row.container === null ? {} : { container: row.container }),
  turnaroundHours: row.turnaround_hours,
  ...(row.service_id === null ? {} : { serviceId: row.service_id }),
  ...(row.service_name === null ? {} : { serviceName: row.service_name }),
  components,
  archived: row.archived,
  version: row.version,
});

const detailsOf = (row: LabTestRow): LabTestDetails => ({
  name: row.name,
  department: row.department,
  resultType: row.result_type,
  unit: row.unit,
  sampleType: row.sample_type,
  container: row.container,
  turnaroundHours: row.turnaround_hours,
  serviceId: row.service_id,
});

// One answer for a test that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'lab_test_not_found', 'No such test');

/** The same id, whatever its capitals: a UUID is written either way. */
const sameId = (sent: string, held: string | null) => sent.toLowerCase() === held;

/** Only a numeric single test has reference ranges. */
const takesRanges = (kind: string, resultType: string) =>
  kind === 'test' && resultType === 'numeric';

const DETAIL_FIELDS = [
  'name',
  'department',
  'resultType',
  'unit',
  'sampleType',
  'container',
  'turnaroundHours',
  'serviceId',
] as const satisfies readonly (keyof LabTestDetails)[];

/**
 * The reference ranges of a body, checked for what a schema cannot say: each row has a limit,
 * `low` is below `high`, a critical limit is never inside the normal range, an age is within 150
 * years in its unit and `ageUntil` is later than `ageFrom` for every date of birth, and two rows
 * for the same sex never both hold for a patient (age.ts). Throws 400 otherwise.
 */
function checkedRanges(ranges: readonly LabRange[]): LabRange[] {
  const accepted: LabRange[] = [];
  for (const [index, range] of ranges.entries()) {
    const at = `ranges.${index}`;
    if (!ageWithinMax(range.ageFrom) || (range.ageUntil && !ageWithinMax(range.ageUntil))) {
      throw invalid(`${at}: an age is at most 150 years`);
    }
    if (range.ageUntil && !ageBefore(range.ageFrom, range.ageUntil)) {
      throw invalid(`${at}: ageUntil is not later than ageFrom for every date of birth`);
    }
    const { low, high, criticalLow, criticalHigh } = range;
    for (const limit of [low, high, criticalLow, criticalHigh]) {
      if (limit !== undefined && !Number.isFinite(limit)) throw invalid(`${at}: not a number`);
    }
    if (low === undefined && high === undefined) throw invalid(`${at}: give low or high`);
    if (low !== undefined && high !== undefined && low >= high) {
      throw invalid(`${at}: low is not below high`);
    }
    const floor = low ?? high;
    const ceiling = high ?? low;
    if (criticalLow !== undefined && floor !== undefined && criticalLow > floor) {
      throw invalid(`${at}: criticalLow is inside the normal range`);
    }
    if (criticalHigh !== undefined && ceiling !== undefined && criticalHigh < ceiling) {
      throw invalid(`${at}: criticalHigh is inside the normal range`);
    }
    const note = tidyOptional(range.note, NOTE_MAX);
    const row: LabRange = {
      sex: range.sex,
      ageFrom: range.ageFrom,
      ...(range.ageUntil ? { ageUntil: range.ageUntil } : {}),
      ...(low === undefined ? {} : { low }),
      ...(high === undefined ? {} : { high }),
      ...(criticalLow === undefined ? {} : { criticalLow }),
      ...(criticalHigh === undefined ? {} : { criticalHigh }),
      ...(note === null ? {} : { note }),
    };
    // Two rows for the same people never cover the same age.
    if (accepted.some((other) => bandsOverlap(other, row))) {
      throw invalid(`${at}: it covers an age that an earlier row for the same sex covers`);
    }
    accepted.push(row);
  }
  return accepted;
}

const OTHER_HOSPITAL =
  ' A test of another hospital answers 404 lab_test_not_found, the same as one that does not exist.';
const NAMED_AT_HOSPITAL =
  ' A `serviceId` must be a laboratory service of the same hospital, and every component of a panel a single test of the same hospital, not archived; a panel has at least one component, none twice, and a single test has none (400 otherwise).';

export const labTestRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of LAB_TEST_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ labTestId: Type.String({ maxLength: 64 }) });

  /** The test as it is after the request's own changes, a panel with its components. */
  async function saved(request: FastifyRequest, id: string): Promise<LabTest> {
    const row = await findLabTest(request.txClient, id);
    if (!row) throw notFound();
    const components = await componentsOf(request.txClient, row.kind === 'panel' ? [id] : []);
    return view(row, components.get(id));
  }

  app.post(
    '/lab-tests/search',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'searchLabTests',
        tags: ['lab-tests'],
        description:
          'The tests and panels the laboratory of the active tenant offers, by name, a panel with its components. Every word of `q` must be in the code or the name, in any order. `total` comes with the first page only. It reads data only. What is searched for travels in the body, never in a query string: the same search is made from prescribing, ordering and billing screens while a patient record is open, and a search term beside a patient id in an access log is patient data. The API does not log the body.',
        body: ref(LabTestSearchRequest),
        response: { 200: ref(LabTestPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as LabTestSearchRequest;
      const result = await searchLabTests(request.txClient, {
        q: body.q,
        department: body.department,
        kind: body.kind,
        archived: body.archived ?? false,
        cursor: body.cursor,
        limit: body.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const components = await componentsOf(
        request.txClient,
        result.rows.filter((row) => row.kind === 'panel').map((row) => row.id),
      );
      return {
        items: result.rows.map((row) => view(row, components.get(row.id))),
        nextCursor: result.nextCursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      };
    },
  );

  app.post(
    '/lab-tests',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createLabTest',
        tags: ['lab-tests'],
        headers: IdempotencyHeaders,
        description:
          "Adds a test or a panel. The hospital is the session's: the body carries no tenant. The code is the test's identity on orders and reports and cannot be changed later; one already used by a test of the hospital, archived or not, whatever its capitals, is refused with 409 lab_test_code_taken. A single test is recorded as text unless `resultType` says numeric; a panel has no result of its own, whatever is sent." +
          NAMED_AT_HOSPITAL +
          ' Audited.',
        body: ref(LabTestCreate),
        response: { 201: ref(LabTest), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const test = await prepareLabTest(request, request.body as LabTestCreate);
      const id = await writeLabTest(request, test);
      return reply.status(201).send(await saved(request, id));
    },
  );

  app.get(
    '/lab-tests/:labTestId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getLabTest',
        tags: ['lab-tests'],
        description: 'One test or panel, a panel with its components.' + OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(LabTest), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => saved(request, request.params.labTestId),
  );

  app.patch(
    '/lab-tests/:labTestId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'updateLabTest',
        tags: ['lab-tests'],
        description:
          'Changes a test: never its code, and never its kind (a test with results cannot become a panel). Send the version the change was made from: 409 conflict when the test has changed since. Empty text removes a unit, a container or the link to a service. A test that has reference ranges cannot become a text test, or change its unit, until they are removed (409 lab_test_has_ranges): the ranges are numbers in that unit. Sending what the test already has changes nothing. A result already reported keeps the name, unit and reference range it was reported with. Audited.' +
          NAMED_AT_HOSPITAL +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(LabTestUpdate),
        response: { 200: ref(LabTest), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as LabTestUpdate;
      // Locked while the versions are compared, so of two changes made from the same version
      // exactly one goes through.
      const current = await lockLabTest(request.txClient, request.params.labTestId);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The test has changed');
      }
      const panel = current.kind === 'panel';
      const before = detailsOf(current);
      const next: LabTestDetails = {
        name: body.name === undefined ? before.name : cleanName(body.name),
        department: body.department ?? before.department,
        resultType: panel ? 'text' : (body.resultType ?? before.resultType),
        unit: panel
          ? null
          : body.unit === undefined
            ? before.unit
            : tidyOptional(body.unit, UNIT_MAX),
        sampleType: body.sampleType ?? before.sampleType,
        container:
          body.container === undefined
            ? before.container
            : tidyOptional(body.container, CONTAINER_MAX),
        turnaroundHours: body.turnaroundHours ?? before.turnaroundHours,
        // The link it already has is left as it is: a service is checked when it is linked.
        serviceId:
          body.serviceId === undefined || sameId(body.serviceId, before.serviceId)
            ? before.serviceId
            : await serviceFor(request, body.serviceId),
      };

      // The components, when they are sent: those of a panel, and none of a single test.
      const had = (await componentsOf(request.txClient, panel ? [current.id] : []))
        .get(current.id)
        ?.map((component) => component.id);
      let componentIds: string[] | undefined;
      if (body.componentIds !== undefined) {
        if (panel) {
          const sent = body.componentIds.map((id) => id.toLowerCase());
          const same = had?.length === sent.length && had.every((id, index) => id === sent[index]);
          // The list it already has is left as it is; a new one is checked and locked.
          if (!same) {
            await componentsFor(request, sent);
            componentIds = sent;
          }
        } else if (body.componentIds.length > 0) {
          throw invalid('A single test has no components');
        }
      }

      const changed: string[] = DETAIL_FIELDS.filter((field) => next[field] !== before[field]);
      if (componentIds) changed.push('componentIds');
      if (changed.length === 0) return saved(request, current.id);
      // The ranges are numbers in the test's unit: they stand only while it is numeric and in
      // that unit.
      if (
        (!takesRanges(current.kind, next.resultType) || next.unit !== before.unit) &&
        (await hasRanges(request.txClient, current.id))
      ) {
        throw new HttpError(409, 'lab_test_has_ranges', 'Remove the reference ranges first');
      }
      // One statement on the test, so one version: also for a change of the components alone.
      await updateLabTest(request.txClient, current.id, next);
      if (componentIds) await replaceComponents(request.txClient, current.id, componentIds);
      request.audit('update', 'lab_test', current.id);
      // The names of the fields, never their values.
      await request.emit('master.changed', current.id, {
        kind: 'lab_test',
        change: 'updated',
        fields: changed,
      });
      return saved(request, current.id);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/lab-tests/:labTestId/${action}`,
      {
        config: { permissions: [MANAGE], feature: FEATURE },
        schema: {
          operationId: `${action}LabTest`,
          tags: ['lab-tests'],
          description:
            (action === 'archive'
              ? 'Archives a test: it stays on the orders and reports that name it and is no longer offered for new ones. A test that is a component of a panel that is not archived is refused with 409 lab_test_in_panel: take it out of the panel first.'
              : 'Brings an archived test back. A panel one of whose tests is archived is refused with 409 lab_test_component_archived: restore that test, or take it out of the panel, first.') +
            ' Doing it twice changes nothing. Audited.' +
            OTHER_HOSPITAL,
          params: Params,
          response: { 200: ref(LabTest), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        // The lock is the one a panel takes on a test it is about to be made of.
        const current = await lockLabTest(request.txClient, request.params.labTestId);
        if (!current) throw notFound();
        if (archive && !current.archived && (await inPanelInUse(request.txClient, current.id))) {
          throw new HttpError(409, 'lab_test_in_panel', 'The test is part of a panel in use');
        }
        // A panel in use is made of tests in use: one whose test was archived while it was
        // archived itself comes back only once that test is restored or taken out of it.
        if (
          !archive &&
          current.archived &&
          current.kind === 'panel' &&
          (await hasArchivedComponent(request.txClient, current.id))
        ) {
          throw new HttpError(
            409,
            'lab_test_component_archived',
            'A test this panel is made of is archived',
          );
        }
        if (await setArchived(request.txClient, current.id, archive)) {
          request.audit(action, 'lab_test', current.id);
          await request.emit('master.changed', current.id, {
            kind: 'lab_test',
            change: archive ? 'archived' : 'restored',
          });
        }
        return saved(request, current.id);
      },
    );
  }

  app.get(
    '/lab-tests/:labTestId/ranges/resolve',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'resolveLabTestRange',
        tags: ['lab-tests'],
        description:
          'The reference range that applies to a patient of an age and a sex: the row for that sex covering that age, else the row for any sex covering it, else none. A patient whose sex is recorded as other gets only a row for any. It answers the check on the catalog screen with an age someone typed, and identifies no patient: the age is tried as that of a person born on 1 January 2001, so 30 days is under one month. It is not how a result is read for a real patient: the laboratory works that out on the server from the date of birth of the patient of the order and the date the sample was collected, with the same rule (a limit is reached on the calendar day that lies that long after the birth; a month or a year lands on the same day of the month, or on the last day of a shorter month), and the age or date of birth of a patient is never sent in an address.' +
          OTHER_HOSPITAL,
        params: Params,
        querystring: LabRangeResolveQuery,
        response: { 200: ref(LabRangeResolved), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      // Checked against the schema above; a query string of enums comes through untyped.
      const query = request.query as { ageValue: number; ageUnit: AgeUnit; sex: string };
      const age: Age = { value: query.ageValue, unit: query.ageUnit };
      if (!ageWithinMax(age)) throw invalid('An age is at most 150 years');
      const test = await findLabTest(request.txClient, request.params.labTestId);
      if (!test) throw notFound();
      const range = bandForAge(await listRanges(request.txClient, test.id), query.sex, age);
      return range ? { range } : {};
    },
  );

  app.get(
    '/lab-tests/:labTestId/ranges',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getLabTestRanges',
        tags: ['lab-tests'],
        description:
          'The reference ranges of a numeric test, by sex and age, with their own version.' +
          OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(LabRanges), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const test = await findLabTest(request.txClient, request.params.labTestId);
      if (!test) throw notFound();
      return {
        labTestId: test.id,
        ranges: await listRanges(request.txClient, test.id),
        version: test.ranges_version,
      };
    },
  );

  app.put(
    '/lab-tests/:labTestId/ranges',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'setLabTestRanges',
        tags: ['lab-tests'],
        description:
          'Replaces the reference ranges of a test. Only a numeric single test has ranges (409 lab_test_has_no_ranges for a panel or a text test). Each row gives at least one limit, `low` below `high`, a critical limit never inside the normal range, and an `ageUntil` that is later than `ageFrom` for every date of birth. Two rows for the same sex must never both hold for a patient: one has to end at or before the age the other starts from, for every date of birth. Years and months compare exactly with each other, and weeks and days with each other; a limit in months or years against one in weeks or days is accepted only when no date of birth can bring them together (a month is 28 to 31 days), so ranges that meet give the age in the same unit. A row for one sex and a row for any may share ages, and the one for the sex is used. 400 otherwise. 409 conflict when the ranges have changed since the version sent. A limit is a number: one sent as null or as text is refused, never read as 0. A result already reported keeps the range it was reported against. Audited.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(LabRangesUpdate),
        response: { 200: ref(LabRanges), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as LabRangesUpdate;
      const test = await lockLabTest(request.txClient, request.params.labTestId);
      if (!test) throw notFound();
      if (!takesRanges(test.kind, test.result_type)) {
        throw new HttpError(
          409,
          'lab_test_has_no_ranges',
          'Only a numeric test has reference ranges',
        );
      }
      if (test.ranges_version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The reference ranges have changed');
      }
      const ranges = checkedRanges(body.ranges);
      const version = await replaceRanges(request.txClient, test.id, ranges);
      request.audit('update', 'lab_test_ranges', test.id);
      await request.emit('master.changed', test.id, {
        kind: 'lab_test_ranges',
        change: 'updated',
      });
      return { labTestId: test.id, ranges, version };
    },
  );
};
