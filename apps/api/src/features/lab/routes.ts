import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyOptional } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { labOrder, moveLabOrder, type LabOrder } from '../clinical/index.js';
import { analytesOf, bandFor, labTestSample, type LabAnalyte } from '../lab-tests/index.js';
import {
  findResult,
  findSample,
  hasResults,
  insertResult,
  insertSample,
  listWorklist,
  nextAccessionId,
  patientForRanges,
  receiveSample,
  rejectSample,
  resultsOf,
  samplesByIds,
  standingSample,
  verifyResult,
  type ResultRow,
  type SampleRow,
  type WorkItemRow,
} from './repository.js';
import { decimalOf, flagOf, isCritical, type RangeLimits } from './results.js';
import {
  COMMENT_MAX,
  LAB_SCHEMAS,
  LabOrderResults,
  LabResult,
  LabResultAmend,
  LabResultsEnter,
  LabResultsVerify,
  LabSample,
  LabSampleReceive,
  LabSampleReject,
  LabWorkItemPage,
  NOTE_MAX,
  OrderParams,
  REASON_MAX,
  ResultParams,
  SampleParams,
  VALUE_MAX,
  WorklistQuery,
  type LabAnalyte as LabAnalyteView,
} from './schemas.js';

export const FEATURE = 'laboratory';

const SAMPLE_READ = 'labSample:read';
const SAMPLE_COLLECT = 'labSample:collect';
const SAMPLE_RECEIVE = 'labSample:receive';
const SAMPLE_REJECT = 'labSample:reject';
const RESULT_READ = 'labResult:read';
const RESULT_ENTER = 'labResult:enter';
const RESULT_VERIFY = 'labResult:verify';

const orderNotFound = () => new HttpError(404, 'order_not_found', 'No such lab order');
const sampleNotFound = () => new HttpError(404, 'sample_not_found', 'No such sample');
const resultNotFound = () => new HttpError(404, 'result_not_found', 'No such result');
const invalid = (message: string) => new HttpError(409, 'invalid_transition', message);

/** An order the laboratory still works: not cancelled, and not completed unless `completed`. */
const closed = (order: LabOrder, { completed = false } = {}) =>
  order.status === 'cancelled' || (!completed && order.status === 'completed');

const iso = (date: Date) => date.toISOString();
const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

function sampleView(row: SampleRow): LabSample {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    accessionId: row.accession_id,
    sampleType: row.sample_type as LabSample['sampleType'],
    ...optional('container', row.container),
    status: row.status,
    collectedAt: iso(row.collected_at),
    collectedByName: row.collected_by_name,
    ...optional('receivedAt', row.received_at && iso(row.received_at)),
    ...optional('receivedByName', row.received_at && (row.received_by_name ?? '')),
    ...optional('rejectedAt', row.rejected_at && iso(row.rejected_at)),
    ...optional('rejectedByName', row.rejected_at && (row.rejected_by_name ?? '')),
    ...optional('rejectReason', row.reject_reason),
    ...optional('rejectNote', row.reject_note),
    version: row.version,
  };
}

function workItemView(row: WorkItemRow, sample: SampleRow | undefined) {
  return {
    orderId: row.order_id,
    tenantId: row.tenant_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientMrn: row.patient_mrn,
    patientDob: row.patient_dob,
    labTestId: row.lab_test_id,
    ...optional('itemCode', row.item_code),
    itemName: row.item_name,
    priority: row.priority,
    ...optional('instructions', row.instructions),
    placedAt: iso(row.placed_at),
    orderedByName: row.ordered_by_name,
    orderStatus: row.order_status,
    sampleType: row.sample_type as LabSample['sampleType'],
    ...optional('container', row.container),
    stage: row.stage,
    ...(sample ? { sample: sampleView(sample) } : {}),
    rejectedSamples: row.rejected_samples,
  };
}

const rangeOf = (row: ResultRow): RangeLimits | null =>
  row.range_low === null && row.range_high === null
    ? null
    : {
        ...optional('low', row.range_low),
        ...optional('high', row.range_high),
        ...optional('criticalLow', row.range_critical_low),
        ...optional('criticalHigh', row.range_critical_high),
        ...optional('note', row.range_note),
      };

function resultView(row: ResultRow): LabResult {
  const range = rangeOf(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sampleId: row.sample_id,
    orderId: row.order_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    labTestId: row.lab_test_id,
    testCode: row.test_code,
    testName: row.test_name,
    resultType: row.result_type,
    value: row.value_number ?? row.value_text ?? '',
    ...optional('unit', row.unit),
    ...(range ? { range } : {}),
    ...optional('flag', row.flag),
    ...optional('comment', row.comment),
    status: row.status,
    enteredAt: iso(row.entered_at),
    enteredByName: row.entered_by_name,
    ...optional('verifiedAt', row.verified_at && iso(row.verified_at)),
    ...optional('verifiedByName', row.verified_at && (row.verified_by_name ?? '')),
    ...optional('amendsId', row.amends_id),
    ...optional('amendmentReason', row.amendment_reason),
    ...optional('amendedById', row.amended_by_id),
    version: row.version,
  };
}

/** The range of a test's band, as a result copies it. */
const limitsOf = (band: RangeLimits | undefined): RangeLimits | null =>
  band
    ? {
        ...optional('low', band.low),
        ...optional('high', band.high),
        ...optional('criticalLow', band.criticalLow),
        ...optional('criticalHigh', band.criticalHigh),
        ...optional('note', band.note),
      }
    : null;

export const labRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of LAB_SCHEMAS) app.addSchema(schema);

  /**
   * The laboratory works the whole hospital's orders, so only the scope `all` reaches anything:
   * a narrower one sees an empty worklist and the same 404 as another hospital's record.
   */
  const reaches = (request: FastifyRequest, permission: Permission) =>
    request.access.scope(permission) === 'all';

  /** The analytes of a test, each with the band for the patient on that day. */
  async function analytesFor(
    request: FastifyRequest,
    labTestId: string,
    patientId: string,
    on: string,
  ): Promise<{ analyte: LabAnalyte; band: RangeLimits | null }[]> {
    const patient = await patientForRanges(request.txClient, patientId);
    return (await analytesOf(request.txClient, labTestId)).map((analyte) => ({
      analyte,
      band: patient ? limitsOf(bandFor(analyte.ranges, patient.gender, patient.dob, on)) : null,
    }));
  }

  /** The results of an order's sample that is not rejected, each read audited. */
  async function orderResults(request: FastifyRequest, order: LabOrder): Promise<LabOrderResults> {
    const sample = await standingSample(request.txClient, order.id);
    const results = sample ? await resultsOf(request.txClient, sample.id) : [];
    const analytes = sample
      ? await analytesFor(request, order.labTestId, order.patientId, sample.collected_on)
      : [];
    request.audit('read', 'order', order.id);
    for (const row of results) request.audit('read', 'lab_result', row.id);
    return {
      orderId: order.id,
      tenantId: sample?.tenant_id ?? (await tenantIdOf(request)),
      encounterId: order.encounterId,
      patientId: order.patientId,
      orderStatus: order.status,
      ...(sample ? { sample: sampleView(sample) } : {}),
      analytes: analytes.map(({ analyte, band }): LabAnalyteView => ({
        labTestId: analyte.id,
        code: analyte.code,
        name: analyte.name,
        resultType: analyte.resultType,
        ...optional('unit', analyte.unit),
        ...(band ? { range: band } : {}),
      })),
      results: results.map(resultView),
    };
  }

  const tenantIdOf = async (request: FastifyRequest) => {
    const { rows } = await request.txClient.query<{ id: string }>(
      'select app_tenant_id()::text as id',
    );
    return rows[0]?.id ?? '';
  };

  /** A lab order the caller reaches with `permission`, locked when `forUpdate`, else 404. */
  async function orderFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false } = {},
  ): Promise<LabOrder> {
    if (!reaches(request, permission)) throw orderNotFound();
    const order = await labOrder(request.txClient, id, { forUpdate });
    if (!order) throw orderNotFound();
    return order;
  }

  /**
   * A sample the caller reaches with `permission`. `forUpdate` locks its order and then the
   * sample, in that order, as every change of the laboratory does.
   */
  async function sampleFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false } = {},
  ): Promise<{ sample: SampleRow; order: LabOrder }> {
    if (!reaches(request, permission)) throw sampleNotFound();
    const found = await findSample(request.txClient, id);
    if (!found) throw sampleNotFound();
    const order = await labOrder(request.txClient, found.order_id, { forUpdate });
    if (!order) throw sampleNotFound();
    if (!forUpdate) return { sample: found, order };
    const sample = await findSample(request.txClient, id, { forUpdate: true });
    if (!sample) throw sampleNotFound();
    return { sample, order };
  }

  // ----- Worklist and samples ------------------------------------------------------------------

  app.get(
    '/lab/worklist',
    {
      config: { permissions: [SAMPLE_READ], feature: FEATURE },
      schema: {
        operationId: 'listLabWorklist',
        tags: ['lab'],
        description:
          'The laboratory’s worklist (#90): the hospital’s lab orders not cancelled or completed, at one stage, stat first, then urgent, then routine, the oldest first within each. Each names the patient (name, MRN and date of birth), the test as ordered and the sample it needs, and its current sample. `total` comes with the first page. Every row read is audited. Requires labSample:read with the scope `all` (a narrower one sees nothing) and the laboratory feature flag. Holds no patient term: a GET.',
        querystring: WorklistQuery,
        response: { 200: ref(LabWorkItemPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query as WorklistQuery;
      if (!reaches(request, SAMPLE_READ)) return { items: [], nextCursor: null, total: 0 };
      const page = await listWorklist(request.txClient, {
        stage: query.stage ?? 'to_collect',
        ...optional('priority', query.priority),
        ...optional('cursor', query.cursor),
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      const samples = await samplesByIds(
        request.txClient,
        page.rows.flatMap((row) => (row.sample_id ? [row.sample_id] : [])),
      );
      for (const row of page.rows) request.audit('read', 'order', row.order_id);
      return {
        items: page.rows.map((row) =>
          workItemView(row, row.sample_id ? samples.get(row.sample_id) : undefined),
        ),
        nextCursor: page.nextCursor,
        ...optional('total', page.total),
      };
    },
  );

  app.post(
    '/lab/orders/:orderId/samples',
    {
      config: {
        permissions: [SAMPLE_COLLECT],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'collectLabSample',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that the sample of a lab order was collected (#90). The server gives it an accession id, unique in the hospital (`YYMMDD-NNNN`, numbered within the hospital day), and the sample type and container of the test as the catalog has them now; the order is accepted if it was only placed. Refused while the order has a sample not rejected (409 `already_collected`) and once the order is cancelled or completed (409 `invalid_transition`). The Idempotency-Key header is required: a repeat answers with the sample as it is now. Requires labSample:collect and the laboratory feature flag. Emits `lab.sample_collected`. Audited.',
        params: OrderParams,
        response: { 201: ref(LabSample), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const { orderId } = request.params;
      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await findSample(request.txClient, request.idempotentId)
          : null;
        if (!again || !reaches(request, SAMPLE_COLLECT)) throw orderNotFound();
        request.audit('read', 'lab_sample', again.id);
        return reply.status(201).send(sampleView(again));
      }
      const order = await orderFor(request, orderId, SAMPLE_COLLECT, { forUpdate: true });
      if (closed(order)) throw invalid(`A ${order.status} order is not collected`);
      if (await standingSample(request.txClient, order.id)) {
        throw new HttpError(409, 'already_collected', 'The order has a sample already');
      }
      const test = await labTestSample(request.txClient, order.labTestId);
      if (!test) throw orderNotFound();
      const id = await insertSample(
        request.txClient,
        {
          orderId: order.id,
          encounterId: order.encounterId,
          patientId: order.patientId,
          labTestId: order.labTestId,
          accessionId: await nextAccessionId(request.txClient),
          sampleType: test.sampleType,
          container: test.container,
        },
        userIdOf(request),
      );
      if (order.status === 'placed') await moveLabOrder(request, order.id, 'accepted');
      request.idempotentId = id;
      request.audit('create', 'lab_sample', id);
      const sample = await findSample(request.txClient, id);
      if (!sample) throw sampleNotFound();
      await request.emit('lab.sample_collected', id, {
        sampleId: id,
        orderId: order.id,
        encounterId: order.encounterId,
        patientId: order.patientId,
        labTestId: order.labTestId,
        accessionId: sample.accession_id,
      });
      return reply.status(201).send(sampleView(sample));
    },
  );

  /** A change of a sample at the version sent, its order and the sample locked. */
  async function changeSample(
    request: FastifyRequest<{ Params: { sampleId: string } }>,
    reply: FastifyReply,
    permission: Permission,
    version: number,
    change: (sample: SampleRow, order: LabOrder) => Promise<void>,
  ) {
    const id = request.params.sampleId;
    if (request.replayOf === null) {
      const { sample, order } = await sampleFor(request, id, permission, { forUpdate: true });
      if (sample.version !== version) {
        throw new HttpError(409, 'conflict', 'The sample has changed since it was read');
      }
      await change(sample, order);
      request.audit('update', 'lab_sample', sample.id);
    }
    const { sample } = await sampleFor(request, id, permission);
    if (request.replayOf !== null) request.audit('read', 'lab_sample', sample.id);
    return reply.status(200).send(sampleView(sample));
  }

  const CHANGE =
    ' At the version sent (409 `conflict`). The Idempotency-Key header is required: a repeat changes nothing and answers with the sample as it is now. Audited.';

  app.post(
    '/lab/samples/:sampleId/receive',
    {
      config: {
        permissions: [SAMPLE_RECEIVE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'receiveLabSample',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records that the laboratory received a collected sample (#90). The order is left as it is: it goes in progress when its first result is entered, so a sample rejected at reception never strands it. From `collected` only, while the order is not cancelled or completed (409 `invalid_transition`). Requires labSample:receive and the laboratory feature flag.' +
          CHANGE,
        params: SampleParams,
        body: ref(LabSampleReceive),
        response: { 200: ref(LabSample), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as LabSampleReceive;
      return changeSample(request, reply, SAMPLE_RECEIVE, body.version, async (sample, order) => {
        if (sample.status !== 'collected' || closed(order)) {
          throw invalid(`A ${sample.status} sample is not received`);
        }
        await receiveSample(request.txClient, sample.id, userIdOf(request));
      });
    },
  );

  app.post(
    '/lab/samples/:sampleId/reject',
    {
      config: {
        permissions: [SAMPLE_REJECT],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'rejectLabSample',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Rejects a collected or received sample with a reason (#90), and a note when the reason is `other` (400 otherwise). Refused for a rejected sample and once the order is cancelled or completed (409 `invalid_transition`), and once the sample has results (409 `has_results`). The sample stays as it is, rejected; the order goes back to be collected again, as a new sample with a new accession id. Requires labSample:reject and the laboratory feature flag. Emits `lab.sample_rejected`.' +
          CHANGE,
        params: SampleParams,
        body: ref(LabSampleReject),
        response: { 200: ref(LabSample), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as LabSampleReject;
      const note = tidyOptional(body.note, NOTE_MAX);
      if (body.reason === 'other' && !note) {
        throw new HttpError(400, 'validation_failed', 'The reason `other` needs a note');
      }
      return changeSample(request, reply, SAMPLE_REJECT, body.version, async (sample, order) => {
        if (sample.status === 'rejected' || closed(order)) {
          throw invalid(`A ${sample.status} sample is not rejected`);
        }
        if (await hasResults(request.txClient, sample.id)) {
          throw new HttpError(409, 'has_results', 'A sample with results is not rejected');
        }
        await rejectSample(request.txClient, sample.id, userIdOf(request), body.reason, note);
        await request.emit('lab.sample_rejected', sample.id, {
          sampleId: sample.id,
          orderId: order.id,
          encounterId: order.encounterId,
          patientId: order.patientId,
          labTestId: order.labTestId,
          reason: body.reason,
        });
      });
    },
  );

  app.post(
    '/lab/samples/:sampleId/print',
    {
      config: {
        permissions: [SAMPLE_READ, SAMPLE_COLLECT],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printLabSampleLabel',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a print of a sample’s label in the audit log, before anything prints (#90). A rejected sample’s label is not printed (409 `not_printable`). The Idempotency-Key header is required, one per press: a repeat records nothing more. Requires labSample:read and labSample:collect and the laboratory feature flag.',
        params: SampleParams,
        response: {
          204: Type.Null({ description: 'Recorded' }),
          ...errors(400, 401, 403, 404, 409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const { sample } = await sampleFor(request, request.params.sampleId, SAMPLE_COLLECT);
      if (!reaches(request, SAMPLE_READ)) throw sampleNotFound();
      if (request.replayOf === null) {
        if (sample.status === 'rejected') {
          throw new HttpError(409, 'not_printable', 'A rejected sample is not labelled');
        }
        request.audit('print', 'lab_sample', sample.id);
      }
      return reply.status(204).send(null);
    },
  );

  // ----- Results -------------------------------------------------------------------------------

  app.get(
    '/lab/orders/:orderId/results',
    {
      config: { permissions: [RESULT_READ], feature: FEATURE },
      schema: {
        operationId: 'getLabOrderResults',
        tags: ['lab'],
        description:
          'The results of a lab order: those of its sample that is not rejected, corrections included, with what they are entered for and the reference range for the patient on the day the sample was collected. No sample yet: no results. Every result read is audited. Requires labResult:read with the scope `all` and the laboratory feature flag.',
        params: OrderParams,
        response: { 200: ref(LabOrderResults), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) =>
      orderResults(request, await orderFor(request, request.params.orderId, RESULT_READ)),
  );

  app.post(
    '/lab/samples/:sampleId/results',
    {
      config: {
        permissions: [RESULT_ENTER],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'enterLabResults',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Enters results of a received sample: some or all of the tests of its order (the test, or each test of the panel), each once (400 otherwise). A test that is not of the order is 422 `unknown_test`, one that has a result already 409 `already_resulted` (correct it instead), a number that is not one 422 `invalid_number`. A sample not received, and an order cancelled or completed, are 409 `invalid_transition`. A number is read against the range for the patient’s sex and age on the day the sample was collected, which the result keeps. The first result moves the order in progress. A critical result emits `lab.critical_value`. The Idempotency-Key header is required: a repeat enters nothing and answers with the results as they are now. Requires labResult:enter and the laboratory feature flag. Audited.',
        params: SampleParams,
        body: ref(LabResultsEnter),
        response: { 201: ref(LabOrderResults), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as LabResultsEnter;
      const id = request.params.sampleId;
      if (request.replayOf !== null) {
        const { order } = await sampleFor(request, id, RESULT_ENTER);
        return reply.status(201).send(await orderResults(request, order));
      }
      const ids = body.results.map((entry) => entry.labTestId);
      if (new Set(ids).size !== ids.length) {
        throw new HttpError(400, 'validation_failed', 'A test is entered once');
      }
      const { sample, order } = await sampleFor(request, id, RESULT_ENTER, { forUpdate: true });
      if (closed(order)) throw invalid(`A ${order.status} order takes no results`);
      if (sample.status !== 'received') throw invalid(`A ${sample.status} sample takes no results`);
      const analytes = new Map(
        (await analytesFor(request, order.labTestId, order.patientId, sample.collected_on)).map(
          (each) => [each.analyte.id, each],
        ),
      );
      const resulted = new Set(
        (await resultsOf(request.txClient, sample.id)).map((r) => r.lab_test_id),
      );
      const userId = userIdOf(request);
      for (const entry of body.results) {
        const found = analytes.get(entry.labTestId);
        if (!found) throw new HttpError(422, 'unknown_test', 'The test is not of this order');
        if (resulted.has(entry.labTestId)) {
          throw new HttpError(409, 'already_resulted', 'The test has a result; correct it instead');
        }
        const { analyte, band } = found;
        const resultId = await enter(request, sample, {
          labTestId: analyte.id,
          testCode: analyte.code,
          testName: analyte.name,
          resultType: analyte.resultType,
          unit: analyte.unit,
          band,
          value: entry.value,
          comment: entry.comment,
          amendsId: null,
          amendmentReason: null,
          userId,
        });
        request.audit('create', 'lab_result', resultId);
      }
      if (order.status === 'accepted') await moveLabOrder(request, order.id, 'in_progress');
      const now = await orderFor(request, order.id, RESULT_ENTER);
      return reply.status(201).send(await orderResults(request, now));
    },
  );

  /** Writes one result, read against its band, and says when it is critical. */
  async function enter(
    request: FastifyRequest,
    sample: SampleRow,
    result: {
      labTestId: string;
      testCode: string;
      testName: string;
      resultType: 'numeric' | 'text';
      unit: string | null;
      band: RangeLimits | null;
      value: string;
      comment: string | undefined;
      amendsId: string | null;
      amendmentReason: string | null;
      userId: string;
    },
  ): Promise<string> {
    const numeric = result.resultType === 'numeric';
    const decimal = numeric ? decimalOf(result.value) : null;
    if (numeric && decimal === null) {
      throw new HttpError(422, 'invalid_number', 'A numeric result is a decimal number');
    }
    const text = numeric ? null : tidyLinesOptional(result.value, VALUE_MAX);
    if (!numeric && !text) throw new HttpError(400, 'validation_failed', 'A result is required');
    const band = numeric ? result.band : null;
    const flag = band && decimal !== null ? flagOf(Number(decimal), band) : null;
    let id: string;
    try {
      id = await insertResult(
        request.txClient,
        {
          sampleId: sample.id,
          orderId: sample.order_id,
          encounterId: sample.encounter_id,
          patientId: sample.patient_id,
          labTestId: result.labTestId,
          testCode: result.testCode,
          testName: result.testName,
          resultType: result.resultType,
          valueNumber: decimal,
          valueText: text,
          unit: numeric ? result.unit : null,
          range: band,
          flag,
          comment: tidyLinesOptional(result.comment, COMMENT_MAX),
          amendsId: result.amendsId,
          amendmentReason: result.amendmentReason,
        },
        result.userId,
      );
    } catch (error) {
      const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
      if (code === '23505' && constraint === 'lab_results_one_first') {
        throw new HttpError(409, 'already_resulted', 'The test has a result; correct it instead');
      }
      if (code === '23505' && constraint === 'lab_results_amended_once') {
        throw new HttpError(409, 'already_amended', 'The result was corrected already');
      }
      throw error;
    }
    if (isCritical(flag)) {
      await request.emit('lab.critical_value', id, {
        resultId: id,
        sampleId: sample.id,
        orderId: sample.order_id,
        encounterId: sample.encounter_id,
        patientId: sample.patient_id,
        labTestId: result.labTestId,
        flag,
      });
    }
    return id;
  }

  app.post(
    '/lab/samples/:sampleId/verify',
    {
      config: {
        permissions: [RESULT_VERIFY],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'verifyLabResults',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Verifies results of a sample, as the verifier read them: each must be a result of the sample (422 `unknown_result`) that is current and not yet verified (409 `conflict`: corrected or verified meanwhile, read again). The person who entered a result may verify it. Once every test of the order has a current result and all are verified, the order is completed (emitting `order.completed`) and `lab.result_verified` is emitted; a correction verified after that emits `lab.result_verified` again. Refused for a cancelled order (409 `invalid_transition`). The Idempotency-Key header is required: a repeat verifies nothing and answers with the results as they are now. Requires labResult:verify and the laboratory feature flag. Audited.',
        params: SampleParams,
        body: ref(LabResultsVerify),
        response: { 200: ref(LabOrderResults), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as LabResultsVerify;
      const id = request.params.sampleId;
      if (request.replayOf !== null) {
        const { order } = await sampleFor(request, id, RESULT_VERIFY);
        return reply.status(200).send(await orderResults(request, order));
      }
      const { sample, order } = await sampleFor(request, id, RESULT_VERIFY, { forUpdate: true });
      if (closed(order, { completed: true }))
        throw invalid(`A ${order.status} order is not verified`);
      const results = new Map((await resultsOf(request.txClient, sample.id)).map((r) => [r.id, r]));
      const userId = userIdOf(request);
      for (const resultId of new Set(body.resultIds)) {
        const result = results.get(resultId);
        if (!result) throw new HttpError(422, 'unknown_result', 'The result is not of this sample');
        if (result.amended_by_id !== null || result.status !== 'entered') {
          throw new HttpError(409, 'conflict', 'The result has changed since it was read');
        }
        await verifyResult(request.txClient, result.id, userId);
        request.audit('update', 'lab_result', result.id);
      }
      const current = (await resultsOf(request.txClient, sample.id)).filter(
        (result) => result.amended_by_id === null,
      );
      const analytes = await analytesOf(request.txClient, order.labTestId);
      const verified = new Set(
        current.filter((result) => result.status === 'verified').map((r) => r.lab_test_id),
      );
      if (analytes.length > 0 && analytes.every((analyte) => verified.has(analyte.id))) {
        if (order.status === 'in_progress') await moveLabOrder(request, order.id, 'completed');
        await request.emit('lab.result_verified', sample.id, {
          sampleId: sample.id,
          orderId: order.id,
          encounterId: order.encounterId,
          patientId: order.patientId,
          labTestId: order.labTestId,
          resultIds: current.map((result) => result.id),
        });
      }
      const now = await orderFor(request, order.id, RESULT_VERIFY);
      return reply.status(200).send(await orderResults(request, now));
    },
  );

  app.post(
    '/lab/results/:resultId/amend',
    {
      config: {
        permissions: [RESULT_ENTER],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'amendLabResult',
        tags: ['lab'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Corrects a result: a new result of the same test and sample, with the whole corrected value and a reason, read against the range the replaced one kept. It is entered, so it needs verifying again; the order stays as it is, completed included. A result is corrected once (409 `already_amended`): a later correction corrects the correction. Refused for a cancelled order (409 `invalid_transition`). A critical result emits `lab.critical_value`. The Idempotency-Key header is required: a repeat answers with the correction as it is now. Requires labResult:enter and the laboratory feature flag. Audited.',
        params: ResultParams,
        body: ref(LabResultAmend),
        response: { 201: ref(LabResult), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as LabResultAmend;
      if (!reaches(request, RESULT_ENTER)) throw resultNotFound();
      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await findResult(request.txClient, request.idempotentId)
          : null;
        if (!again) throw resultNotFound();
        request.audit('read', 'lab_result', again.id);
        return reply.status(201).send(resultView(again));
      }
      const reason = tidyOptional(body.reason, REASON_MAX);
      if (!reason) throw new HttpError(400, 'validation_failed', 'A reason is required');
      const found = await findResult(request.txClient, request.params.resultId);
      if (!found) throw resultNotFound();
      const { sample, order } = await sampleFor(request, found.sample_id, RESULT_ENTER, {
        forUpdate: true,
      });
      if (closed(order, { completed: true }))
        throw invalid(`A ${order.status} order is not corrected`);
      const result = await findResult(request.txClient, found.id);
      if (!result) throw resultNotFound();
      if (result.amended_by_id !== null) {
        throw new HttpError(409, 'already_amended', 'The result was corrected already');
      }
      const id = await enter(request, sample, {
        labTestId: result.lab_test_id,
        testCode: result.test_code,
        testName: result.test_name,
        resultType: result.result_type,
        unit: result.unit,
        band: rangeOf(result),
        value: body.value,
        comment: body.comment,
        amendsId: result.id,
        amendmentReason: reason,
        userId: userIdOf(request),
      });
      request.idempotentId = id;
      request.audit('create', 'lab_result', id);
      const amended = await findResult(request.txClient, id);
      if (!amended) throw resultNotFound();
      return reply.status(201).send(resultView(amended));
    },
  );
};
