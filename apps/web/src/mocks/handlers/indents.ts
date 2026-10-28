import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, currentPolicy, onMockReset, TENANT_IDS, USER_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDrug } from './drugs';
import {
  mockBatch,
  mockOnHandOf,
  mockPlaceInUse,
  mockPlacesInUse,
  mockTransfer,
  mockUsableBatches,
} from './inventory';

type Drug = components['schemas']['Drug'];
type StockIndent = components['schemas']['StockIndent'];
type StockIndentLine = components['schemas']['StockIndentLine'];
type StockIndentStatus = components['schemas']['StockIndentStatus'];
type StockIssue = components['schemas']['StockIssue'];
type StockItemName = components['schemas']['StockItemName'];

const FEATURE_FLAG = 'inventory';
const READ = 'indent:read';
const CREATE = 'indent:create';
const APPROVE = 'indent:approve';
const ISSUE = 'indent:issue';
const STATUSES: readonly StockIndentStatus[] = [
  'requested',
  'approved',
  'rejected',
  'cancelled',
  'partly_issued',
  'issued',
  'closed',
];
const OPEN: readonly StockIndentStatus[] = ['approved', 'partly_issued'];

const reference = (prefix: 'IND' | 'IV', number: number) =>
  `${prefix}-${String(number).padStart(6, '0')}`;

function itemName(drug: Drug): StockItemName {
  return {
    drugId: drug.id,
    type: drug.type,
    genericName: drug.genericName,
    ...(drug.brandName ? { brandName: drug.brandName } : {}),
    form: drug.form,
    ...(drug.strength ? { strength: drug.strength } : {}),
    ...(drug.unit ? { unit: drug.unit } : {}),
  };
}

/** An indent as the mock holds it: its lines without the store's stock, read when answered. */
type Indent = Omit<StockIndent, 'lines'> & {
  lines: Omit<StockIndentLine, 'storeOnHand' | 'batches'>[];
};

/**
 * Indents and issue vouchers (#105), as the API: a place asks a store, someone who did not ask
 * approves it (for up to what was asked), and the store issues it on vouchers that move stock
 * through the inventory mock (`mockTransfer`). At the hospital: `ind_h_requested` (IND-000001,
 * the pharmacist's, the pharmacy counter asking the main store for two items, waiting) and
 * `ind_h_approved` (IND-000002, the admin's for Ward 2 stock, approved by the store keeper, nothing
 * issued). The clinic has inventory off.
 */
function seed() {
  const state = {
    indents: [] as Indent[],
    answered: new Map<string, { body: string; reply: unknown; status: number }>(),
    counters: new Map<string, number>(),
    counter: 0,
  };
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const tenantId = TENANT_IDS.hospital;
  const items = ['bat_h_1A', 'bat_h_2A', 'bat_h_4A']
    .map((batchId) => mockBatch(batchId))
    .map((batch) => (batch ? mockDrug(tenantId, batch.drugId) : undefined));
  const [first, second, third] = items;
  if (!first || !second || !third) return state;
  const line = (id: string, number: number, drug: Drug, asked: number, approved?: number) => ({
    id,
    lineNumber: number,
    item: itemName(drug),
    requestedQuantity: asked,
    ...(approved === undefined ? {} : { approvedQuantity: approved }),
    issuedQuantity: 0,
  });
  state.counters.set(`${tenantId}:indent`, 2);
  state.indents.push({
    id: 'ind_h_requested',
    tenantId,
    reference: reference('IND', 1),
    fromLocationId: 'loc_h_pharmacy',
    fromLocationName: 'Pharmacy counter',
    toLocationId: 'loc_h_store',
    toLocationName: 'Main store',
    status: 'requested',
    requestedById: USER_IDS.pharmacist,
    requestedByName: 'Sample Pharmacist',
    requestedAt: at(0),
    note: 'For the weekend',
    lines: [
      line('ind_h_requested_line_1', 1, first, 50),
      line('ind_h_requested_line_2', 2, second, 30),
    ],
    issues: [],
    version: 1,
  });
  state.indents.push({
    id: 'ind_h_approved',
    tenantId,
    reference: reference('IND', 2),
    fromLocationId: 'loc_h_ward',
    fromLocationName: 'Ward 2 stock',
    toLocationId: 'loc_h_store',
    toLocationName: 'Main store',
    status: 'approved',
    requestedById: USER_IDS.admin,
    requestedByName: 'Sample Admin',
    requestedAt: at(1),
    decidedByName: 'Sample Store Keeper',
    decidedAt: at(1),
    lines: [line('ind_h_approved_line_1', 1, third, 40, 40)],
    issues: [],
    version: 2,
  });
  return state;
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** For tests: the mock's indents as they are now. */
export const mockIndents = () => state.indents;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };
const invalid = (message = 'The request is not valid') => error(400, 'validation_failed', message);
const conflict = () => error(409, 'conflict', 'It has changed since it was read');
const gone = () => error(404, 'indent_not_found', 'No such indent');
const tidy = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const wholeUnits = (value: unknown, min: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 1_000_000;

function nextNumber(tenantId: string, kind: 'indent' | 'issue') {
  const key = `${tenantId}:${kind}`;
  const number = (state.counters.get(key) ?? 0) + 1;
  state.counters.set(key, number);
  return number;
}

/** Whether the caller holds a permission: who issues is offered the batches, and who approves or issues sees the store's stock. */
const holds = (permission: string) =>
  (currentPolicy()?.permissions ?? []).some((grant) => grant.permission === permission);

function viewOf(indent: Indent): StockIndent {
  const offer = OPEN.includes(indent.status) && holds(ISSUE);
  const decides = holds(ISSUE) || holds(APPROVE);
  const batches = offer
    ? mockUsableBatches(
        indent.tenantId,
        indent.lines.map((line) => line.item.drugId),
        indent.toLocationId,
      )
    : [];
  return {
    ...indent,
    lines: indent.lines.map((line) => ({
      ...line,
      ...(decides
        ? { storeOnHand: mockOnHandOf(indent.tenantId, line.item.drugId, indent.toLocationId) }
        : {}),
      ...(offer
        ? {
            batches: batches
              .filter((batch) => batch.drugId === line.item.drugId)
              .map(({ batchId, batchNumber, expiryDate, onHand }) => ({
                batchId,
                batchNumber,
                expiryDate,
                onHand,
              })),
          }
        : {}),
    })),
  };
}

const summaryOf = (indent: Indent) => {
  const {
    lines,
    issues: _issues,
    note: _note,
    decidedByName: _decidedByName,
    decidedAt: _decidedAt,
    rejectionNote: _rejectionNote,
    endedByName: _endedByName,
    endedAt: _endedAt,
    endNote: _endNote,
    ...head
  } = indent;
  return { ...head, lineCount: lines.length };
};

/** The idempotency key of a POST, per hospital and user: a repeat answers as the first did. */
async function idempotent(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const keyOf = key ? `${tenantId}:${callerOf().id}:${new URL(request.url).pathname}:${key}` : null;
  const earlier = keyOf ? state.answered.get(keyOf) : undefined;
  if (earlier && earlier.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    } as const;
  }
  const answer = (reply: unknown, status = 200) => {
    if (keyOf) state.answered.set(keyOf, { body: JSON.stringify(body), reply, status });
    return HttpResponse.json(reply as Record<string, unknown>, { status });
  };
  return {
    body,
    answer,
    replay: earlier
      ? HttpResponse.json(earlier.reply as Record<string, unknown>, { status: earlier.status })
      : null,
  } as const;
}

/** A POST to an indent, with its access, body and indent at the version sent. */
async function step(request: Request, indentId: unknown, permission: string) {
  const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
  if ('denied' in access) return { done: access.denied } as const;
  const sent = await idempotent(request, access.tenantId);
  if ('refused' in sent) return { done: sent.refused } as const;
  if (sent.replay) return { done: sent.replay } as const;
  const indent = state.indents.find(
    (each) => each.id === indentId && each.tenantId === access.tenantId,
  );
  if (!indent) return { done: gone() } as const;
  const body = sent.body;
  if (!isObject(body)) return { done: invalid() } as const;
  if (body.expectedVersion !== indent.version) return { done: conflict() } as const;
  return { access, sent, indent, body } as const;
}

/** Moves an indent on, counting the change. */
const move = (indent: Indent, change: Partial<Indent>) =>
  Object.assign(indent, change, { version: indent.version + 1 });

export const indentHandlers = [
  http.get('*/api/inventory/indent-places', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const items = mockPlacesInUse(access.tenantId);
    return HttpResponse.json({ items, nextCursor: null, total: items.length });
  }),

  http.get('*/api/inventory/indents', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const locationId = url.searchParams.get('locationId');
    if (status !== null && !STATUSES.includes(status as StockIndentStatus)) return invalid();
    const rows = state.indents
      .filter(
        (each) =>
          each.tenantId === access.tenantId &&
          (status === null || each.status === status) &&
          (locationId === null ||
            each.fromLocationId === locationId ||
            each.toLocationId === locationId),
      )
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id));
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
    const cursor = url.searchParams.get('cursor');
    let start = 0;
    if (cursor) {
      const index = rows.findIndex((row) => row.id === cursor);
      if (index < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
      start = index + 1;
    }
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return HttpResponse.json({
      items: items.map(summaryOf),
      nextCursor: start + limit < rows.length && last ? last.id : null,
      ...(cursor ? {} : { total: rows.length }),
    });
  }),

  http.get('*/api/inventory/indents/:indentId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const indent = state.indents.find(
      (each) => each.id === params.indentId && each.tenantId === access.tenantId,
    );
    return indent ? HttpResponse.json(viewOf(indent)) : gone();
  }),

  http.post('*/api/inventory/indents', async ({ request }) => {
    const access = authorize(request, { permission: CREATE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) return sent.replay;
    const body = sent.body;
    if (!isObject(body) || !Array.isArray(body.lines) || body.lines.length === 0) return invalid();
    const from = mockPlaceInUse(access.tenantId, String(body.fromLocationId));
    const to = mockPlaceInUse(access.tenantId, String(body.toLocationId));
    const store = mockPlacesInUse(access.tenantId).find((each) => each.id === to?.id);
    if (!from || !to || from.id === to.id || store?.kind !== 'store') {
      return invalid('Two different places in use, the one asked a store');
    }
    const seen = new Set<string>();
    const lines: Indent['lines'] = [];
    for (const [index, sentLine] of (body.lines as unknown[]).entries()) {
      if (!isObject(sentLine) || !wholeUnits(sentLine.quantity, 1)) return invalid();
      const drug = mockDrug(access.tenantId, String(sentLine.drugId));
      if (!drug || drug.archived || seen.has(drug.id)) return invalid();
      seen.add(drug.id);
      state.counter += 1;
      lines.push({
        id: `ind_line_${state.counter}`,
        lineNumber: index + 1,
        item: itemName(drug),
        requestedQuantity: sentLine.quantity as number,
        issuedQuantity: 0,
      });
    }
    const caller = callerOf();
    state.counter += 1;
    const note = tidy(body.note);
    const indent: Indent = {
      id: `ind_new_${state.counter}`,
      tenantId: access.tenantId,
      reference: reference('IND', nextNumber(access.tenantId, 'indent')),
      fromLocationId: from.id,
      fromLocationName: from.name,
      toLocationId: to.id,
      toLocationName: to.name,
      status: 'requested',
      requestedById: caller.id,
      requestedByName: caller.name,
      requestedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
      lines,
      issues: [],
      version: 1,
    };
    state.indents.push(indent);
    return sent.answer(viewOf(indent), 201);
  }),

  ...(['approve', 'reject'] as const).map((action) =>
    http.post(`*/api/inventory/indents/:indentId/${action}`, async ({ request, params }) => {
      const found = await step(request, params.indentId, APPROVE);
      if ('done' in found) return found.done;
      const { indent, body, sent } = found;
      if (indent.status !== 'requested') {
        return error(409, 'indent_decided', 'The indent was decided already');
      }
      const caller = callerOf();
      if (indent.requestedById === caller.id) {
        return error(409, 'own_indent', 'Someone else decides an indent you asked for');
      }
      const decided = { decidedByName: caller.name, decidedAt: new Date().toISOString() };
      if (action === 'reject') {
        const note = tidy(body.note);
        if (!note) return invalid('Say why it is rejected');
        move(indent, { status: 'rejected', rejectionNote: note, ...decided });
        return sent.answer(viewOf(indent));
      }
      const quantities = new Map<string, number>();
      for (const each of Array.isArray(body.lines) ? (body.lines as unknown[]) : []) {
        if (!isObject(each) || !wholeUnits(each.quantity, 0)) return invalid();
        quantities.set(String(each.lineId), each.quantity as number);
      }
      if (
        quantities.size !== indent.lines.length ||
        indent.lines.some(
          (line) => (quantities.get(line.id) ?? Infinity) > line.requestedQuantity,
        ) ||
        [...quantities.values()].every((quantity) => quantity === 0)
      ) {
        return invalid();
      }
      for (const line of indent.lines) line.approvedQuantity = quantities.get(line.id);
      move(indent, { status: 'approved', ...decided });
      return sent.answer(viewOf(indent));
    }),
  ),

  http.post('*/api/inventory/indents/:indentId/cancel', async ({ request, params }) => {
    const found = await step(request, params.indentId, CREATE);
    if ('done' in found) return found.done;
    const { indent, sent } = found;
    if (indent.status !== 'requested') {
      return error(409, 'indent_decided', 'The indent was decided already');
    }
    const caller = callerOf();
    if (indent.requestedById !== caller.id) {
      return error(409, 'not_requester', 'Only whoever asked withdraws an indent');
    }
    move(indent, {
      status: 'cancelled',
      endedByName: caller.name,
      endedAt: new Date().toISOString(),
    });
    return sent.answer(viewOf(indent));
  }),

  http.post('*/api/inventory/indents/:indentId/close', async ({ request, params }) => {
    const found = await step(request, params.indentId, ISSUE);
    if ('done' in found) return found.done;
    const { indent, body, sent } = found;
    const note = tidy(body.note);
    if (!note) return invalid('Say why it is closed');
    if (!OPEN.includes(indent.status)) {
      return error(409, 'indent_not_open', 'The indent is not waiting to be issued');
    }
    move(indent, {
      status: 'closed',
      endedByName: callerOf().name,
      endedAt: new Date().toISOString(),
      endNote: note,
    });
    return sent.answer(viewOf(indent));
  }),

  http.post('*/api/inventory/indents/:indentId/issues', async ({ request, params }) => {
    const found = await step(request, params.indentId, ISSUE);
    if ('done' in found) return found.done;
    const { indent, body, sent, access } = found;
    if (!OPEN.includes(indent.status)) {
      return error(409, 'indent_not_open', 'The indent is not waiting to be issued');
    }
    const rows: { line: Indent['lines'][number]; batchId: string; quantity: number }[] = [];
    const batches = new Set<string>();
    for (const each of Array.isArray(body.lines) ? (body.lines as unknown[]) : []) {
      if (!isObject(each) || !wholeUnits(each.quantity, 1)) return invalid();
      const line = indent.lines.find((candidate) => candidate.id === each.indentLineId);
      const batchId = String(each.batchId);
      if (!line || batches.has(batchId)) return invalid();
      batches.add(batchId);
      rows.push({ line, batchId, quantity: each.quantity as number });
    }
    if (rows.length === 0) return invalid();
    for (const line of indent.lines) {
      const wanted = rows
        .filter((row) => row.line === line)
        .reduce((sum, row) => sum + row.quantity, 0);
      if (wanted > (line.approvedQuantity ?? 0) - line.issuedQuantity) {
        return error(409, 'over_issue', 'More than the line has still to issue');
      }
    }
    const caller = callerOf();
    state.counter += 1;
    const issueId = `iss_${state.counter}`;
    const movementOf = (line: Indent['lines'][number], dryRun: boolean) => ({
      fromLocationId: indent.toLocationId,
      toLocationId: indent.fromLocationId,
      drugId: line.item.drugId,
      sourceId: issueId,
      actorName: caller.name,
      lines: rows
        .filter((row) => row.line === line)
        .map((row) => ({ batchId: row.batchId, quantity: row.quantity })),
      dryRun,
    });
    const touched = indent.lines.filter((line) => rows.some((row) => row.line === line));
    // All or nothing, as the API's one transaction.
    for (const line of touched) {
      const checked = mockTransfer(access.tenantId, movementOf(line, true));
      if ('refused' in checked) {
        return error(
          checked.refused === 'unknown_location' ? 422 : 409,
          checked.refused,
          'Refused',
        );
      }
    }
    const issueLines: StockIssue['lines'] = [];
    for (const line of touched) {
      const moved = mockTransfer(access.tenantId, movementOf(line, false));
      if ('refused' in moved) return error(409, moved.refused, 'Refused');
      const lineRows = rows.filter((row) => row.line === line);
      moved.batches.forEach((batch, index) => {
        const quantity = lineRows[index]?.quantity ?? 0;
        line.issuedQuantity += quantity;
        issueLines.push({
          indentLineId: line.id,
          drugId: line.item.drugId,
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity,
        });
      });
    }
    indent.issues.push({
      id: issueId,
      reference: reference('IV', nextNumber(access.tenantId, 'issue')),
      ...(tidy(body.note) ? { note: tidy(body.note) } : {}),
      issuedByName: caller.name,
      issuedAt: new Date().toISOString(),
      lines: issueLines,
    });
    const done = indent.lines.every((line) => line.issuedQuantity === (line.approvedQuantity ?? 0));
    move(indent, { status: done ? 'issued' : 'partly_issued' });
    return sent.answer(viewOf(indent), 201);
  }),
];
