import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type ProgressNote = components['schemas']['ProgressNote'];
type ProgressNoteVersion = components['schemas']['ProgressNoteVersion'];
type Stored = ProgressNote & { key: string; history: ProgressNoteVersion[] };

const FEATURE_FLAG = 'nursing';

let notes: Stored[] = [];
let counter = 0;
onMockReset(() => {
  notes = [];
  counter = 0;
});

/** For tests: a note already written on a stay. */
export function addMockProgressNote(
  note: Partial<ProgressNote> & { id: string; admissionId: string },
) {
  const stored: Stored = {
    tenantId: TENANT_IDS.hospital,
    kind: 'observation',
    body: 'Comfortable.',
    createdAt: '2026-11-08T09:00:00.000Z',
    createdById: 'user_doctor',
    createdByName: 'Dr. Asha Rao',
    updatedAt: '2026-11-08T09:00:00.000Z',
    updatedById: 'user_doctor',
    version: 1,
    key: note.id,
    history: [],
    ...note,
  };
  stored.history = [
    {
      version: 1,
      body: stored.body,
      editedAt: stored.createdAt,
      editedById: stored.createdById,
      editedByName: stored.createdByName,
    },
  ];
  notes.push(stored);
}

const view = ({ key: _key, history: _history, ...note }: Stored): ProgressNote => note;

function pageOf<T>(request: Request, all: T[], idOf: (each: T) => string) {
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((each) => idOf(each) === cursor) : 0;
  if (start < 0) return null;
  const next = all[start + limit];
  return {
    items: all.slice(start, start + limit),
    nextCursor: next ? idOf(next) : null,
    ...(cursor ? {} : { total: all.length }),
  };
}

const newestFirst = (a: Stored, b: Stored) => b.createdAt.localeCompare(a.createdAt);

export const notesHandlers = [
  http.get('*/api/admissions/:admissionId/progress-notes', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'progressNote:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const own = notes
      .filter(
        (each) => each.tenantId === access.tenantId && each.admissionId === params.admissionId,
      )
      .sort(newestFirst);
    const page = pageOf(request, own, (each) => each.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({ ...page, items: page.items.map(view) });
  }),

  http.post('*/api/admissions/:admissionId/progress-notes', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'progressNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('idempotency-key');
    if (key === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const repeat = notes.find((each) => each.key === key && each.tenantId === access.tenantId);
    if (repeat) return HttpResponse.json(view(repeat), { status: 201 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.body !== 'string' ||
      body.body === '' ||
      typeof body.kind !== 'string'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const user = currentSession()?.user;
    counter += 1;
    const now = new Date(Date.now() + counter).toISOString();
    const note: Stored = {
      id: `note_${counter}`,
      tenantId: access.tenantId,
      admissionId: String(params.admissionId),
      kind: body.kind as ProgressNote['kind'],
      body: body.body,
      createdAt: now,
      createdById: user?.id ?? '',
      createdByName: user?.name ?? '',
      updatedAt: now,
      updatedById: user?.id ?? '',
      version: 1,
      key,
      history: [],
    };
    note.history.push({
      version: 1,
      body: note.body,
      editedAt: now,
      editedById: note.createdById,
      editedByName: note.createdByName,
    });
    notes.push(note);
    return HttpResponse.json(view(note), { status: 201 });
  }),

  http.patch('*/api/progress-notes/:noteId', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'progressNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const note = notes.find(
      (each) => each.id === params.noteId && each.tenantId === access.tenantId,
    );
    if (!note) return error(404, 'note_not_found', 'No such note');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.body !== 'string' || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const user = currentSession()?.user;
    if (note.createdById !== user?.id) return error(403, 'not_author', 'Only the author edits');
    if (body.version !== note.version) return error(409, 'conflict', 'The note was changed');
    note.version += 1;
    note.body = body.body;
    note.updatedAt = new Date().toISOString();
    note.updatedById = user.id;
    note.history.push({
      version: note.version,
      body: note.body,
      editedAt: note.updatedAt,
      editedById: user.id,
      editedByName: user.name,
    });
    return HttpResponse.json(view(note));
  }),

  http.get('*/api/progress-notes/:noteId/history', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'progressNote:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const note = notes.find(
      (each) => each.id === params.noteId && each.tenantId === access.tenantId,
    );
    if (!note) return error(404, 'note_not_found', 'No such note');
    const page = pageOf(
      request,
      [...note.history].sort((a, b) => b.version - a.version),
      (each) => String(each.version),
    );
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json(page);
  }),
];
