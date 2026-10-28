import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { stockableDrug } from '../drugs/index.js';
import {
  approveLines,
  findIndent,
  indentIssues,
  indentLines,
  insertIndent,
  insertIssue,
  insertIssueLine,
  issueBatches,
  listIndents,
  lockIndent,
  moveIndent,
  nextNumber,
  type IndentLineRow,
  type IndentRow,
} from './indent-repository.js';
import {
  isUuid,
  isViolation,
  listLocations,
  lockLocation,
  type ItemColumns,
} from './repository.js';
import {
  NOTE_MAX,
  StockIndent,
  StockIndentApprove,
  StockIndentCancel,
  StockIndentCreate,
  StockIndentEnd,
  StockIndentListQuery,
  StockIndentPage,
  StockIssueCreate,
  StockLocationListQuery,
  StockLocationPage,
  type IndentStatus,
  type StockIndentSummary,
  type StockItemName,
} from './schemas.js';
import { transferStock } from './stock-out.js';

const FEATURE = 'inventory';

const READ = 'indent:read';
const CREATE = 'indent:create';
const APPROVE = 'indent:approve';
const ISSUE = 'indent:issue';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const conflict = () => new HttpError(409, 'conflict', 'It has changed since it was read');
const indentGone = () => new HttpError(404, 'indent_not_found', 'No such indent');
const badCursor = () => new HttpError(400, 'invalid_cursor', 'Unknown cursor');
const notOpen = () =>
  new HttpError(409, 'indent_not_open', 'The indent is not waiting to be issued');
const decided = () => new HttpError(409, 'indent_decided', 'The indent was decided already');

const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const reference = (prefix: 'IND' | 'IV', number: number) =>
  `${prefix}-${String(number).padStart(6, '0')}`;

const itemView = (row: ItemColumns): StockItemName => ({
  drugId: row.drug_id,
  type: row.drug_type,
  genericName: row.generic_name,
  ...optional('brandName', row.brand_name),
  form: row.form,
  ...optional('strength', row.strength),
  ...optional('unit', row.unit),
});

const summaryView = (row: IndentRow): StockIndentSummary => ({
  id: row.id,
  tenantId: row.tenant_id,
  reference: reference('IND', row.number),
  fromLocationId: row.from_location_id,
  fromLocationName: row.from_location_name,
  toLocationId: row.to_location_id,
  toLocationName: row.to_location_name,
  status: row.status,
  requestedById: row.requested_by,
  requestedByName: row.requested_by_name ?? '',
  requestedAt: row.requested_at.toISOString(),
  lineCount: row.line_count,
  version: row.version,
});

/** Statuses an indent is issued from. */
const OPEN: readonly IndentStatus[] = ['approved', 'partly_issued'];

export const indentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const IndentParams = Type.Object({ indentId: Type.String({ maxLength: 64 }) });

  /**
   * What the caller does with indents beyond reading them: whoever issues is offered the batches,
   * and whoever approves or issues sees the store's stock of each item (a nurse who only asks does
   * not). Scope is not read, as in the rest of inventory: a store's stock is the hospital's.
   */
  async function holds(request: FastifyRequest): Promise<{ issues: boolean; decides: boolean }> {
    const policy = await request.access.policy();
    const held = new Set((policy?.permissions ?? []).map((grant) => grant.permission));
    return { issues: held.has(ISSUE), decides: held.has(ISSUE) || held.has(APPROVE) };
  }

  async function indentView(request: FastifyRequest, row: IndentRow): Promise<StockIndent> {
    const client = request.txClient;
    const lines = await indentLines(client, row);
    const { issues: vouchers, lines: voucherLines } = await indentIssues(client, row.id);
    const caller = await holds(request);
    const offer = OPEN.includes(row.status) && caller.issues;
    const batches = offer
      ? await issueBatches(
          client,
          lines.map((line) => line.drug_id),
          row.to_location_id,
        )
      : [];
    const lineView = (line: IndentLineRow) => ({
      id: line.id,
      lineNumber: line.line_number,
      item: itemView(line),
      requestedQuantity: line.requested_quantity,
      ...optional('approvedQuantity', line.approved_quantity),
      issuedQuantity: line.issued_quantity,
      ...(caller.decides ? { storeOnHand: line.store_on_hand } : {}),
      ...(offer
        ? {
            batches: batches
              .filter((batch) => batch.drug_id === line.drug_id)
              .map((batch) => ({
                batchId: batch.batch_id,
                batchNumber: batch.batch_number,
                expiryDate: batch.expiry_date,
                onHand: batch.on_hand,
              })),
          }
        : {}),
    });
    return {
      ...summaryView(row),
      ...optional('note', row.note),
      ...optional('decidedByName', row.decided_by_name),
      ...optional('decidedAt', row.decided_at?.toISOString()),
      ...optional('rejectionNote', row.rejection_note),
      ...optional('endedByName', row.ended_by_name),
      ...optional('endedAt', row.ended_at?.toISOString()),
      ...optional('endNote', row.end_note),
      lines: lines.map(lineView),
      issues: vouchers.map((voucher) => ({
        id: voucher.id,
        reference: reference('IV', voucher.number),
        ...optional('note', voucher.note),
        issuedByName: voucher.issued_by_name ?? '',
        issuedAt: voucher.issued_at.toISOString(),
        lines: voucherLines
          .filter((line) => line.issue_id === voucher.id)
          .map((line) => ({
            indentLineId: line.indent_line_id,
            drugId: line.drug_id,
            batchId: line.batch_id,
            batchNumber: line.batch_number,
            expiryDate: line.expiry_date,
            quantity: line.quantity,
          })),
      })),
    };
  }

  async function answer(request: FastifyRequest, id: string): Promise<StockIndent> {
    const row = await findIndent(request.txClient, id);
    if (!row) throw indentGone();
    return indentView(request, row);
  }

  /** The indent, locked, at the version sent. */
  async function locked(
    request: FastifyRequest,
    indentId: string,
    expectedVersion: number,
  ): Promise<IndentRow> {
    const current = await lockIndent(request.txClient, indentId);
    if (!current) throw indentGone();
    if (current.version !== expectedVersion) throw conflict();
    return current;
  }

  // --- places ----------------------------------------------------------------------------------

  app.get(
    '/inventory/indent-places',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listIndentPlaces',
        tags: ['inventory'],
        description:
          'The places in use, by name, for asking and filtering indents: what `GET /inventory/locations` gives, to a caller who indents without seeing the stock. `total` comes with the first page.',
        querystring: StockLocationListQuery,
        response: { 200: ref(StockLocationPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const list = await listLocations(request.txClient, { archived: false, cursor, limit });
      if (!list) throw badCursor();
      return {
        items: list.rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          kind: row.kind,
          archived: row.archived,
          version: row.version,
        })),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  // --- indents ---------------------------------------------------------------------------------

  app.get(
    '/inventory/indents',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listStockIndents',
        tags: ['inventory'],
        description:
          'The indents, newest asked first, of a status and of a place (the one that asked or the one asked), or all. `total` comes with the first page. No patient data: a GET.',
        querystring: StockIndentListQuery,
        response: { 200: ref(StockIndentPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query;
      if (query.locationId !== undefined && !isUuid(query.locationId)) {
        return { items: [], nextCursor: null, total: 0 };
      }
      const list = await listIndents(request.txClient, {
        status: (query.status as IndentStatus | undefined) ?? null,
        locationId: query.locationId?.toLowerCase() ?? null,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!list) throw badCursor();
      return {
        items: list.rows.map(summaryView),
        nextCursor: list.nextCursor,
        ...optional('total', list.total),
      };
    },
  );

  app.get(
    '/inventory/indents/:indentId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getStockIndent',
        tags: ['inventory'],
        description:
          'An indent with each line’s units asked, approved and issued, and its vouchers. A caller who approves or issues also gets the store’s stock of each item; while it waits to be issued, a caller who issues gets the batches the store may issue of each line, nearest expiry first. Another hospital’s answers 404.',
        params: IndentParams,
        response: { 200: ref(StockIndent), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => answer(request, request.params.indentId),
  );

  /** A place that is in use, held so it is not archived meanwhile. */
  async function placeInUse(request: FastifyRequest, locationId: string, field: string) {
    const location = await lockLocation(request.txClient, locationId, 'share');
    if (!location || location.archived) {
      throw invalid(`${field} is not a place of this hospital that is in use`);
    }
    return location;
  }

  app.post(
    '/inventory/indents',
    {
      // Names of items, places and staff only, no patient data: a replay returns it whole.
      config: { permissions: [CREATE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Asks a store for items for a place: two different places in use, the one asked a store (400), each item in use and once (400), whole units. It waits for someone who did not ask to approve it. Audited.',
        body: ref(StockIndentCreate),
        response: { 201: ref(StockIndent), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as StockIndentCreate;
      const requestedBy = userIdOf(request);
      if (body.fromLocationId.toLowerCase() === body.toLocationId.toLowerCase()) {
        throw invalid('A place does not indent from itself');
      }
      const from = await placeInUse(request, body.fromLocationId, 'fromLocationId');
      const to = await placeInUse(request, body.toLocationId, 'toLocationId');
      if (to.kind !== 'store') throw invalid('toLocationId is not a store');
      const seen = new Set<string>();
      for (const line of body.lines) {
        const drug = await stockableDrug(request.txClient, line.drugId);
        if (!drug) throw invalid('drugId is not an item of this hospital that is in use');
        if (seen.has(drug.id)) throw invalid('An item is asked for once');
        seen.add(drug.id);
      }
      const number = await nextNumber(request.txClient, 'indent');
      const id = await insertIndent(request.txClient, {
        number,
        fromLocationId: from.id,
        toLocationId: to.id,
        note: tidyOptional(body.note, NOTE_MAX),
        requestedBy,
        lines: body.lines.map((line) => ({
          drugId: line.drugId.toLowerCase(),
          quantity: line.quantity,
        })),
      });
      request.audit('create', 'stock_indent', id);
      return reply.status(201).send(await answer(request, id));
    },
  );

  /** A requested indent, locked, at its version, that someone else asked for. */
  async function toDecide(
    request: FastifyRequest,
    indentId: string,
    expectedVersion: number,
    decidedBy: string,
  ): Promise<IndentRow> {
    const current = await locked(request, indentId, expectedVersion);
    if (current.status !== 'requested') throw decided();
    if (current.requested_by === decidedBy) {
      throw new HttpError(409, 'own_indent', 'Someone else decides an indent you asked for');
    }
    return current;
  }

  app.post(
    '/inventory/indents/:indentId/approve',
    {
      config: { permissions: [APPROVE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'approveStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Approves a requested indent someone else asked for (409 own_indent), at its version (409 conflict), with the units approved of every line, each up to what it asked and at least one above 0 (400). Nothing moves until it is issued. 409 indent_decided once decided or cancelled. Audited.',
        params: IndentParams,
        body: ref(StockIndentApprove),
        response: { 200: ref(StockIndent), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockIndentApprove;
      const decidedBy = userIdOf(request);
      const current = await toDecide(
        request,
        request.params.indentId,
        body.expectedVersion,
        decidedBy,
      );
      const lines = await indentLines(request.txClient, current);
      const sent = new Map(body.lines.map((line) => [line.lineId.toLowerCase(), line.quantity]));
      if (sent.size !== body.lines.length || sent.size !== lines.length) {
        throw invalid('Every line of the indent, once');
      }
      for (const line of lines) {
        const quantity = sent.get(line.id);
        if (quantity === undefined) throw invalid('Every line of the indent, once');
        if (quantity > line.requested_quantity) {
          throw invalid('A line is approved for up to what it asked');
        }
      }
      if ([...sent.values()].every((quantity) => quantity === 0)) {
        throw invalid('Approve at least one unit, or reject the indent');
      }
      await approveLines(
        request.txClient,
        current.id,
        [...sent].map(([lineId, quantity]) => ({ lineId, quantity })),
      );
      await moveIndent(request.txClient, current.id, { status: 'approved', decidedBy });
      request.audit('update', 'stock_indent', current.id);
      return answer(request, current.id);
    },
  );

  app.post(
    '/inventory/indents/:indentId/reject',
    {
      config: { permissions: [APPROVE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'rejectStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Rejects a requested indent someone else asked for, with a note saying why. The same refusals as approving. Audited.',
        params: IndentParams,
        body: ref(StockIndentEnd),
        response: { 200: ref(StockIndent), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockIndentEnd;
      const decidedBy = userIdOf(request);
      const note = tidyWithin(body.note, NOTE_MAX);
      if (note === '') throw invalid('Say why it is rejected');
      const current = await toDecide(
        request,
        request.params.indentId,
        body.expectedVersion,
        decidedBy,
      );
      await moveIndent(request.txClient, current.id, { status: 'rejected', decidedBy, note });
      request.audit('update', 'stock_indent', current.id);
      return answer(request, current.id);
    },
  );

  app.post(
    '/inventory/indents/:indentId/cancel',
    {
      config: { permissions: [CREATE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'cancelStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Withdraws an indent before it is decided: only whoever asked for it (409 not_requester), at its version. 409 indent_decided once decided. Audited.',
        params: IndentParams,
        body: ref(StockIndentCancel),
        response: { 200: ref(StockIndent), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockIndentCancel;
      const userId = userIdOf(request);
      const current = await locked(request, request.params.indentId, body.expectedVersion);
      if (current.status !== 'requested') throw decided();
      if (current.requested_by !== userId) {
        throw new HttpError(409, 'not_requester', 'Only whoever asked withdraws an indent');
      }
      await moveIndent(request.txClient, current.id, { status: 'cancelled', endedBy: userId });
      request.audit('update', 'stock_indent', current.id);
      return answer(request, current.id);
    },
  );

  app.post(
    '/inventory/indents/:indentId/close',
    {
      config: { permissions: [ISSUE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'closeStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Closes an approved or partly issued indent with units still to issue, with a note saying why: nothing more is issued on it. 409 indent_not_open otherwise. Audited.',
        params: IndentParams,
        body: ref(StockIndentEnd),
        response: { 200: ref(StockIndent), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as StockIndentEnd;
      const userId = userIdOf(request);
      const note = tidyWithin(body.note, NOTE_MAX);
      if (note === '') throw invalid('Say why it is closed');
      const current = await locked(request, request.params.indentId, body.expectedVersion);
      if (!OPEN.includes(current.status)) throw notOpen();
      await moveIndent(request.txClient, current.id, { status: 'closed', endedBy: userId, note });
      request.audit('update', 'stock_indent', current.id);
      return answer(request, current.id);
    },
  );

  // --- issue vouchers --------------------------------------------------------------------------

  app.post(
    '/inventory/indents/:indentId/issues',
    {
      config: { permissions: [ISSUE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'issueStockIndent',
        tags: ['inventory'],
        headers: IdempotencyHeaders,
        description:
          'Issues units of an approved or partly issued indent (409 indent_not_open) at its version, on a new voucher: each row a batch of a line’s item, once per voucher (400), taken out of the store and brought in at the place that asked through the ledger. Never more of a line than approved less what was issued (409 over_issue), nor more than the batch has at the store (409 insufficient_stock); an expired batch is 409 batch_expired, a place archived since 422 unknown_location. The indent is issued once every line has its approved units, partly issued until then. Emits `stock.issued`. Audited.',
        params: IndentParams,
        body: ref(StockIssueCreate),
        response: { 201: ref(StockIndent), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as StockIssueCreate;
      const issuedBy = userIdOf(request);
      const current = await locked(request, request.params.indentId, body.expectedVersion);
      if (!OPEN.includes(current.status)) throw notOpen();
      const lines = await indentLines(request.txClient, current);
      const byId = new Map(lines.map((line) => [line.id, line]));
      const rows = body.lines.map((row) => ({
        indentLineId: row.indentLineId.toLowerCase(),
        batchId: row.batchId.toLowerCase(),
        quantity: row.quantity,
      }));
      const batchesSeen = new Set<string>();
      const wanted = new Map<string, number>();
      for (const row of rows) {
        const line = byId.get(row.indentLineId);
        if (!line) throw invalid('indentLineId is not a line of this indent');
        if (batchesSeen.has(row.batchId)) throw invalid('A batch is once on a voucher');
        batchesSeen.add(row.batchId);
        wanted.set(line.id, (wanted.get(line.id) ?? 0) + row.quantity);
      }
      const overIssue = () =>
        new HttpError(409, 'over_issue', 'More than the line has still to issue');
      for (const [lineId, quantity] of wanted) {
        const line = byId.get(lineId);
        if (!line || quantity > (line.approved_quantity ?? 0) - line.issued_quantity) {
          throw overIssue();
        }
      }
      const number = await nextNumber(request.txClient, 'issue');
      const issueId = await insertIssue(request.txClient, {
        number,
        indentId: current.id,
        fromLocationId: current.to_location_id,
        toLocationId: current.from_location_id,
        note: tidyOptional(body.note, NOTE_MAX),
        issuedBy,
      });
      // Items in id order, so two vouchers of the same items never wait for each other.
      const items = [
        ...new Set(rows.map((row) => byId.get(row.indentLineId)?.drug_id ?? '')),
      ].sort();
      for (const drugId of items) {
        const itemRows = rows.filter((row) => byId.get(row.indentLineId)?.drug_id === drugId);
        const posted = await transferStock(request, {
          fromLocationId: current.to_location_id,
          toLocationId: current.from_location_id,
          drugId,
          sourceId: issueId,
          actorId: issuedBy,
          lines: itemRows.map((row) => ({ batchId: row.batchId, quantity: row.quantity })),
        });
        for (const [index, entry] of posted.entries()) {
          const row = itemRows[index];
          if (!row) continue;
          try {
            await insertIssueLine(request.txClient, {
              issueId,
              indentId: current.id,
              indentLineId: row.indentLineId,
              drugId,
              batchId: entry.batchId,
              quantity: entry.quantity,
              outEntryId: entry.outEntryId,
              inEntryId: entry.inEntryId,
            });
          } catch (error) {
            if (isViolation(error, 'stock_indent_lines_issued_quantity_check')) throw overIssue();
            throw error;
          }
        }
      }
      const after = await indentLines(request.txClient, current);
      const done = after.every((line) => line.issued_quantity === (line.approved_quantity ?? 0));
      await moveIndent(request.txClient, current.id, {
        status: done ? 'issued' : 'partly_issued',
      });
      request.audit('create', 'stock_issue', issueId);
      request.audit('update', 'stock_indent', current.id);
      await request.emit('stock.issued', issueId, {
        indentId: current.id,
        issueId,
        fromLocationId: current.to_location_id,
        toLocationId: current.from_location_id,
      });
      return reply.status(201).send(await answer(request, current.id));
    },
  );
};
