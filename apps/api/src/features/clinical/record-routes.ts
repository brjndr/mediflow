import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { diagnosisCode } from '../codes/index.js';
import {
  diagnosisView,
  encounterFor,
  FEATURE,
  invalid,
  noteBody,
  noteView,
  uniqueRefusal,
  userIdOf,
} from './http.js';
import {
  deleteDraft,
  findDiagnosis,
  findNote,
  insertDiagnosis,
  insertNote,
  listDiagnoses,
  listNotes,
  retractDiagnosis,
  saveDraft,
  signNote,
  type NoteRow,
} from './repository.js';
import {
  ClinicalNote,
  ClinicalNoteAmend,
  ClinicalNoteCreate,
  ClinicalNotePage,
  ClinicalNoteSign,
  ClinicalNoteUpdate,
  Diagnosis,
  DiagnosisCreate,
  DiagnosisPage,
  DiagnosisParams,
  DiagnosisRetract,
  DIAGNOSIS_TEXT_MAX,
  EncounterParams,
  NoteParams,
  PageQuery,
  REASON_MAX,
} from './schemas.js';

const NOTE_READ = 'clinicalNote:read';
const NOTE_WRITE = 'clinicalNote:write';
const DIAGNOSIS_READ = 'diagnosis:read';
const DIAGNOSIS_WRITE = 'diagnosis:write';

const noteNotFound = () => new HttpError(404, 'note_not_found', 'No such note');
const diagnosisNotFound = () => new HttpError(404, 'diagnosis_not_found', 'No such diagnosis');

const reasonOf = (text: string) => {
  const reason = tidyWithin(text, REASON_MAX);
  if (reason === '') throw invalid('A reason is needed');
  return reason;
};

const SCOPE =
  ' The encounter decides who reaches it: one of another hospital, or outside the scope the caller holds the route’s permission with, is 404 as one that does not exist.';

/** The route's 404 for a child whose encounter the caller does not reach. */
async function encounterOrNotFound(
  request: FastifyRequest,
  encounterId: string,
  permission: Permission,
  notFound: () => HttpError,
  options: { open?: boolean } = {},
) {
  try {
    return await encounterFor(request, encounterId, permission, options);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'encounter_not_found') throw notFound();
    throw error;
  }
}

export const recordRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // ----- Notes ---------------------------------------------------------------------------------

  const notePage = async (
    request: FastifyRequest,
    encounterId: string,
    query: { cursor?: string; limit?: number },
  ) => {
    await encounterFor(request, encounterId, NOTE_READ);
    const page = await listNotes(request.txClient, encounterId, userIdOf(request), {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
    for (const row of page.rows) request.audit('read', 'clinical_note', row.id);
    return {
      items: page.rows.map(noteView),
      nextCursor: page.nextCursor,
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  };

  app.get(
    '/encounters/:encounterId/notes',
    {
      config: { permissions: [NOTE_READ], feature: FEATURE },
      schema: {
        operationId: 'listClinicalNotes',
        tags: ['clinical'],
        description:
          'The encounter’s signed notes, amendments included, and the caller’s own drafts, oldest first; another person’s draft is nobody else’s to read. A note that has been amended names its amendment (`amendedById`). Requires clinicalNote:read and the clinical feature flag. Every note of a page is audited.' +
          SCOPE,
        params: EncounterParams,
        querystring: PageQuery,
        response: { 200: ref(ClinicalNotePage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => notePage(request, request.params.encounterId, request.query),
  );

  /**
   * A note the caller reaches: signed, or their own draft, in an encounter they reach.
   * `forUpdate` locks it only once the scope is checked, so a caller outside it cannot hold
   * another's note locked; `open` requires the encounter open, locked shared.
   */
  async function noteFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false, open = false }: { forUpdate?: boolean; open?: boolean } = {},
  ): Promise<NoteRow> {
    const userId = userIdOf(request);
    const row = await findNote(request.txClient, id, userId);
    if (!row) throw noteNotFound();
    await encounterOrNotFound(request, row.encounter_id, permission, noteNotFound, { open });
    if (!forUpdate) return row;
    const locked = await findNote(request.txClient, row.id, userId, { forUpdate: true });
    if (!locked) throw noteNotFound();
    return locked;
  }

  app.post(
    '/encounters/:encounterId/notes',
    {
      config: {
        permissions: [NOTE_WRITE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createClinicalNote',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Starts a draft note in an open encounter (409 `encounter_not_open` otherwise). The draft is kept on the server, never in the browser, and only its author reads, edits, signs or discards it. The Idempotency-Key header is required: a repeat writes nothing and answers with the note as it is now. Requires clinicalNote:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: EncounterParams,
        body: ref(ClinicalNoteCreate),
        response: { 201: ref(ClinicalNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = userIdOf(request);
      if (request.replayOf !== null) {
        const note = request.idempotentId
          ? await noteFor(request, request.idempotentId, NOTE_WRITE)
          : null;
        if (!note) throw noteNotFound();
        request.audit('read', 'clinical_note', note.id);
        return reply.status(201).send(noteView(note));
      }
      const body = noteBody((request.body as ClinicalNoteCreate).body);
      const encounter = await encounterFor(request, request.params.encounterId, NOTE_WRITE, {
        open: true,
      });
      const id = await insertNote(
        request.txClient,
        {
          encounterId: encounter.id,
          patientId: encounter.patient_id,
          body,
          amendsId: null,
          amendmentReason: null,
        },
        userId,
      );
      request.idempotentId = id;
      request.audit('create', 'clinical_note', id);
      const note = await findNote(request.txClient, id, userId);
      if (!note) throw new Error('note was not written');
      return reply.status(201).send(noteView(note));
    },
  );

  app.get(
    '/notes/:noteId',
    {
      config: { permissions: [NOTE_READ], feature: FEATURE },
      schema: {
        operationId: 'getClinicalNote',
        tags: ['clinical'],
        description:
          'One note: signed, or the caller’s own draft (another person’s draft is 404 `note_not_found`). Requires clinicalNote:read and the clinical feature flag. Audited.' +
          SCOPE,
        params: NoteParams,
        response: { 200: ref(ClinicalNote), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const note = await noteFor(request, request.params.noteId, NOTE_READ);
      request.audit('read', 'clinical_note', note.id);
      return noteView(note);
    },
  );

  /** A draft of the caller's, locked, in an open encounter, at the version the edit started from. */
  async function draftFor(request: FastifyRequest, id: string, version: number) {
    const note = await noteFor(request, id, NOTE_WRITE, { forUpdate: true, open: true });
    if (note.status !== 'draft') {
      throw new HttpError(409, 'note_signed', 'A signed note is amended, not edited');
    }
    if (note.version !== version) {
      throw new HttpError(409, 'conflict', 'The note has changed since it was read');
    }
    return note;
  }

  app.patch(
    '/notes/:noteId',
    {
      config: { permissions: [NOTE_WRITE], feature: FEATURE },
      schema: {
        operationId: 'saveClinicalNote',
        tags: ['clinical'],
        description:
          'Saves the caller’s draft, whole, from the version the edit started from (409 `conflict` otherwise, and nothing changes). A signed note is 409 `note_signed`: it is amended instead. The encounter must be open (409 `encounter_not_open`). No Idempotency-Key: the version does that job. Requires clinicalNote:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: NoteParams,
        body: ref(ClinicalNoteUpdate),
        response: { 200: ref(ClinicalNote), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as ClinicalNoteUpdate;
      const text = noteBody(body.body);
      const note = await draftFor(request, request.params.noteId, body.version);
      await saveDraft(request.txClient, note.id, text);
      request.audit('update', 'clinical_note', note.id);
      const now = await findNote(request.txClient, note.id, userIdOf(request));
      if (!now) throw noteNotFound();
      return noteView(now);
    },
  );

  app.post(
    '/notes/:noteId/sign',
    {
      config: {
        permissions: [NOTE_WRITE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'signClinicalNote',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Signs the caller’s draft at the version it was read (409 `conflict` otherwise) in an open encounter. A signed note never changes again, and the database refuses any change of one; an edit is an amendment. Already signed is 409 `note_signed`. The Idempotency-Key header is required: a repeat changes nothing and answers with the note as it is now. Requires clinicalNote:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: NoteParams,
        body: ref(ClinicalNoteSign),
        response: { 200: ref(ClinicalNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const id = request.params.noteId;
      if (request.replayOf === null) {
        const note = await draftFor(request, id, (request.body as ClinicalNoteSign).version);
        await signNote(request.txClient, note.id);
        request.audit('update', 'clinical_note', note.id);
      }
      const now = await noteFor(request, id, NOTE_WRITE);
      if (request.replayOf !== null) request.audit('read', 'clinical_note', now.id);
      return reply.status(200).send(noteView(now));
    },
  );

  app.delete(
    '/notes/:noteId',
    {
      config: { permissions: [NOTE_WRITE], feature: FEATURE },
      schema: {
        operationId: 'discardClinicalNote',
        tags: ['clinical'],
        description:
          'Discards the caller’s own draft: a draft is not yet on the record. A signed note is never removed (409 `note_signed`). Requires clinicalNote:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: NoteParams,
        response: {
          204: Type.Null({ description: 'Discarded' }),
          ...errors(401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      const note = await noteFor(request, request.params.noteId, NOTE_WRITE, { forUpdate: true });
      if (note.status !== 'draft') {
        throw new HttpError(409, 'note_signed', 'A signed note is never removed');
      }
      await deleteDraft(request.txClient, note.id);
      request.audit('delete', 'clinical_note', note.id);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/notes/:noteId/amendments',
    {
      config: {
        permissions: [NOTE_WRITE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'amendClinicalNote',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Amends a signed note: a new note, signed as it is written, with the whole corrected text and a reason, naming the note it amends. The amended note is kept as it was. A note is amended once (409 `already_amended`, decided by a unique index): a later correction amends the amendment, so the history is one line. A draft is edited, not amended (409 `note_not_signed`). Allowed after the encounter closed; not in a cancelled one (409 `encounter_not_open`). Any member with clinicalNote:write may amend, not only the author. The Idempotency-Key header is required: a repeat writes nothing and answers with the amendment. Requires clinicalNote:write and the clinical feature flag. Audited (`create` of the amendment).' +
          SCOPE,
        params: NoteParams,
        body: ref(ClinicalNoteAmend),
        response: { 201: ref(ClinicalNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = userIdOf(request);
      if (request.replayOf !== null) {
        const amendment = request.idempotentId
          ? await noteFor(request, request.idempotentId, NOTE_WRITE)
          : null;
        if (!amendment) throw noteNotFound();
        request.audit('read', 'clinical_note', amendment.id);
        return reply.status(201).send(noteView(amendment));
      }
      const body = request.body as ClinicalNoteAmend;
      const text = noteBody(body.body);
      const reason = reasonOf(body.reason);
      const note = await noteFor(request, request.params.noteId, NOTE_WRITE);
      if (note.status !== 'signed') {
        throw new HttpError(409, 'note_not_signed', 'A draft is edited, not amended');
      }
      // Closed is fine. A cancelled one has no signed note, but the rule is said here too.
      const encounter = await encounterOrNotFound(
        request,
        note.encounter_id,
        NOTE_WRITE,
        noteNotFound,
      );
      if (encounter.status === 'cancelled') {
        throw new HttpError(409, 'encounter_not_open', 'The encounter is cancelled');
      }
      if (note.amended_by_id !== null) {
        throw new HttpError(409, 'already_amended', 'The note is already amended');
      }
      let id: string;
      try {
        id = await insertNote(
          request.txClient,
          {
            encounterId: note.encounter_id,
            patientId: note.patient_id,
            body: text,
            amendsId: note.id,
            amendmentReason: reason,
          },
          userId,
        );
      } catch (error) {
        throw uniqueRefusal(error, {
          clinical_notes_amended_once: new HttpError(
            409,
            'already_amended',
            'The note is already amended',
          ),
        });
      }
      request.idempotentId = id;
      request.audit('create', 'clinical_note', id);
      const amendment = await findNote(request.txClient, id, userId);
      if (!amendment) throw new Error('amendment was not written');
      return reply.status(201).send(noteView(amendment));
    },
  );

  // ----- Diagnoses -----------------------------------------------------------------------------

  app.get(
    '/encounters/:encounterId/diagnoses',
    {
      config: { permissions: [DIAGNOSIS_READ], feature: FEATURE },
      schema: {
        operationId: 'listDiagnoses',
        tags: ['clinical'],
        description:
          'The encounter’s diagnoses, oldest first, retracted ones included with who retracted them and why. A permission of its own, so a role may see the encounter without what it was for. Requires diagnosis:read and the clinical feature flag. Every diagnosis of a page is audited.' +
          SCOPE,
        params: EncounterParams,
        querystring: PageQuery,
        response: { 200: ref(DiagnosisPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const encounter = await encounterFor(request, request.params.encounterId, DIAGNOSIS_READ);
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listDiagnoses(request.txClient, encounter.id, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'diagnosis', row.id);
      return {
        items: page.rows.map(diagnosisView),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  /** A diagnosis in an encounter the caller reaches with `permission`. */
  async function diagnosisFor(
    request: FastifyRequest,
    id: string,
    permission: Permission,
    { forUpdate = false }: { forUpdate?: boolean } = {},
  ) {
    const row = await findDiagnosis(request.txClient, id);
    if (!row) throw diagnosisNotFound();
    await encounterOrNotFound(request, row.encounter_id, permission, diagnosisNotFound);
    // Locked only once the scope is checked.
    if (!forUpdate) return row;
    const locked = await findDiagnosis(request.txClient, row.id, { forUpdate: true });
    if (!locked) throw diagnosisNotFound();
    return locked;
  }

  app.post(
    '/encounters/:encounterId/diagnoses',
    {
      config: {
        permissions: [DIAGNOSIS_WRITE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'recordDiagnosis',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a diagnosis, provisional or final, in an open encounter (409 `encounter_not_open` otherwise): an ICD-10 code (422 `unknown_code` for an id that is not one), text, or both (400 with neither). The code and its title are kept as they read now. A diagnosis is never changed: one that no longer stands is retracted, and a provisional one that is confirmed is recorded again as final. The Idempotency-Key header is required: a repeat records nothing and answers with the diagnosis. Requires diagnosis:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: EncounterParams,
        body: ref(DiagnosisCreate),
        response: { 201: ref(Diagnosis), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const recorded = request.idempotentId
          ? await diagnosisFor(request, request.idempotentId, DIAGNOSIS_WRITE)
          : null;
        if (!recorded) throw diagnosisNotFound();
        request.audit('read', 'diagnosis', recorded.id);
        return reply.status(201).send(diagnosisView(recorded));
      }
      const body = request.body as DiagnosisCreate;
      const text = tidyOptional(body.text, DIAGNOSIS_TEXT_MAX);
      if (body.codeId === undefined && text === null) throw invalid('A code or a text is needed');
      const encounter = await encounterFor(request, request.params.encounterId, DIAGNOSIS_WRITE, {
        open: true,
      });
      const code =
        body.codeId === undefined ? null : await diagnosisCode(request.txClient, body.codeId);
      if (body.codeId !== undefined && !code) {
        throw new HttpError(422, 'unknown_code', 'No such ICD-10 code');
      }
      const id = await insertDiagnosis(
        request.txClient,
        {
          encounterId: encounter.id,
          patientId: encounter.patient_id,
          code,
          text,
          kind: body.kind,
        },
        userIdOf(request),
      );
      request.idempotentId = id;
      request.audit('create', 'diagnosis', id);
      const recorded = await findDiagnosis(request.txClient, id);
      if (!recorded) throw new Error('diagnosis was not recorded');
      return reply.status(201).send(diagnosisView(recorded));
    },
  );

  app.post(
    '/diagnoses/:diagnosisId/retract',
    {
      config: {
        permissions: [DIAGNOSIS_WRITE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'retractDiagnosis',
        tags: ['clinical'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Retracts a diagnosis with a reason: it stays, with who retracted it and when. Once (409 `already_retracted`), and also after the encounter closed. The Idempotency-Key header is required: a repeat changes nothing and answers with the diagnosis as it is now. Requires diagnosis:write and the clinical feature flag. Audited.' +
          SCOPE,
        params: DiagnosisParams,
        body: ref(DiagnosisRetract),
        response: { 200: ref(Diagnosis), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const id = request.params.diagnosisId;
      if (request.replayOf === null) {
        const reason = reasonOf((request.body as DiagnosisRetract).reason);
        const row = await diagnosisFor(request, id, DIAGNOSIS_WRITE, { forUpdate: true });
        if (row.retracted_at !== null) {
          throw new HttpError(409, 'already_retracted', 'The diagnosis is already retracted');
        }
        await retractDiagnosis(request.txClient, row.id, reason, userIdOf(request));
        request.audit('update', 'diagnosis', row.id);
      }
      const now = await diagnosisFor(request, id, DIAGNOSIS_WRITE);
      if (request.replayOf !== null) request.audit('read', 'diagnosis', now.id);
      return reply.status(200).send(diagnosisView(now));
    },
  );
};
