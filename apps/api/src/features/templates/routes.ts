import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import {
  isEmptyRichText,
  sanitizeRichText,
  type RichTextDocument,
  type RichTextNode,
} from '../../core/http/rich-text.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { unknownPlaceholders, type TemplateKind } from './placeholders.js';
import {
  findByName,
  findTemplate,
  findVersion,
  insertTemplate,
  insertVersion,
  isNameTaken,
  listTemplates,
  listVersions,
  redactVersion,
  setArchived,
  type TemplateRow,
} from './repository.js';
import type { Template } from './schemas.js';
import {
  NAME_MAX,
  TEMPLATE_SCHEMAS,
  TemplateCreate,
  TemplateDetail,
  TemplateListQuery,
  TemplatePage,
  TemplateRedact,
  TemplateSave,
  TemplateVersion,
  VERSIONS_MAX,
} from './schemas.js';

const FEATURE = 'templates';
const READ = 'template:read';
const MANAGE = 'template:manage';
const REDACT = 'template:redact';

const view = (row: TemplateRow): Template => ({
  id: row.id,
  tenantId: row.tenant_id,
  kind: row.kind,
  name: row.name,
  version: row.version,
  savedAt: row.saved_at.toISOString(),
  archived: row.archived,
});

// One answer for a template that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'template_not_found', 'No such template');
const versionNotFound = () => new HttpError(404, 'template_version_not_found', 'No such version');
const taken = () =>
  new HttpError(409, 'template_name_taken', 'A template of this kind has that name');
const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A name as it is stored, and not empty once it is tidied. */
function cleanName(name: string): string {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** Half of a surrogate pair: the database refuses it in a document, as it does a NUL. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUL = String.fromCharCode(0);
const unstorable = (text: string) => text.includes(NUL) || LONE_SURROGATE.test(text);

function storable(nodes: readonly RichTextNode[]): boolean {
  return nodes.every((node) =>
    node.type === 'text'
      ? !unstorable(node.text)
      : !('content' in node) || !node.content || storable(node.content),
  );
}

/**
 * The text of a request, reduced to what a document may hold and checked: it is not empty, and
 * every placeholder in it is one a template of this kind knows. Throws 400 otherwise.
 */
function cleanBody(kind: TemplateKind, value: unknown): RichTextDocument {
  const body = sanitizeRichText(value);
  if (isEmptyRichText(body)) throw invalid('body: the text is empty');
  if (!storable(body.content)) throw invalid('body: a character that is not text');
  // The names are not repeated in the answer: an unknown one is whatever was typed.
  if (unknownPlaceholders(kind, body).length > 0) {
    throw invalid('body: a placeholder this kind of template does not know');
  }
  return body;
}

/** The same text, whatever order the database gives the keys of a stored document in. */
const sameText = (stored: unknown, sent: RichTextDocument) =>
  JSON.stringify(sanitizeRichText(stored)) === JSON.stringify(sent);

const asBody = (document: unknown) =>
  sanitizeRichText(document) as unknown as Record<string, unknown>;

const userOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'Sign in first');
  return userId;
};

/** The template with the text of its newest version and the list of every version. */
async function detail(request: FastifyRequest, template: TemplateRow): Promise<TemplateDetail> {
  const newest = await findVersion(request.txClient, template.id, template.version);
  const versions = await listVersions(request.txClient, template.id);
  return {
    template: view(template),
    body: asBody(newest?.body),
    versions: versions.map((row) => ({
      version: row.version,
      savedAt: row.saved_at.toISOString(),
      savedByName: row.saved_by_name,
      ...(row.redacted_at === null ? {} : { redactedAt: row.redacted_at.toISOString() }),
    })),
  };
}

const PLACEHOLDERS =
  ' The body is not empty, and every placeholder in it is one the kind of template knows (400 otherwise): patient.name, patient.mrn, patient.age, patient.sex, doctor.name, hospital.name and date.today for every kind; procedure.name for a consent form; admission.date and discharge.date for a discharge summary; study.name and study.modality for an imaging report. A template is a blank form: it holds no patient data, and a placeholder is filled in only when a document is made from it.';
const OTHER_HOSPITAL =
  ' A template of another hospital answers 404 template_not_found, the same as one that does not exist.';

export const templateRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of TEMPLATE_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ templateId: Type.String({ maxLength: 64 }) });
  const VersionParams = Type.Object({
    templateId: Type.String({ maxLength: 64 }),
    // Any number the database can hold: a version the template never had is a 404, not a 400.
    version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  });

  app.get(
    '/templates',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listTemplates',
        tags: ['templates'],
        description:
          'The document templates of the active tenant, by name: each hospital has its own. Requires template:read and the templates feature flag. `total` comes with the first page only.',
        querystring: TemplateListQuery,
        response: { 200: ref(TemplatePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      // One of the kinds, by the schema.
      const kind = request.query.kind as TemplateKind | undefined;
      const list = await listTemplates(request.txClient, { kind, archived, cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(view),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/templates',
    {
      // The answer holds the text, and a template's text is what a redaction may one day have to
      // remove: nothing of it is kept for a replay. A repeat is answered from the template itself.
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'none' } },
      schema: {
        operationId: 'createTemplate',
        tags: ['templates'],
        headers: IdempotencyHeaders,
        description:
          'Adds a template, as its version 1. Requires template:manage and template:read. The hospital is the session’s. The kind cannot be changed later. A name another template of the same kind has at the hospital, archived or not, whatever the capitals, is refused with 409 template_name_taken.' +
          PLACEHOLDERS +
          ' Audited. A repeat with the same Idempotency-Key adds nothing and answers with the template as it is now.',
        body: ref(TemplateCreate),
        response: { 201: ref(TemplateDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const sent = request.body as TemplateCreate;
      const name = cleanName(sent.name);
      if (request.replayOf !== null) {
        // The same request as before: the template it added, as it is now, found by its id and
        // never by its name, which may have changed since.
        const added = request.idempotentId
          ? await findTemplate(request.txClient, request.idempotentId)
          : null;
        if (!added) throw notFound();
        return reply.status(201).send(await detail(request, added));
      }
      const body = cleanBody(sent.kind, sent.body);
      if (await findByName(request.txClient, sent.kind, name)) throw taken();
      let id: string;
      try {
        id = await insertTemplate(request.txClient, userOf(request), {
          kind: sent.kind,
          name,
          body,
        });
      } catch (error) {
        // Two requests for the same new name at once: the database lets one through.
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      request.idempotentId = id;
      request.audit('create', 'template', id);
      await request.emit('master.changed', id, { kind: 'template', change: 'created' });
      const template = await findTemplate(request.txClient, id);
      if (!template) throw notFound();
      return reply.status(201).send(await detail(request, template));
    },
  );

  app.get(
    '/templates/:templateId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getTemplate',
        tags: ['templates'],
        description:
          'One template with the text of its newest version and the list of every version it has had. Requires template:read.' +
          OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(TemplateDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const template = await findTemplate(request.txClient, request.params.templateId);
      if (!template) throw notFound();
      return detail(request, template);
    },
  );

  app.put(
    '/templates/:templateId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'saveTemplateVersion',
        tags: ['templates'],
        description:
          `Saves a new version of a template: the name, the text, or both. Requires template:manage and template:read. Versions are append-only: nothing saved is ever changed or removed, except by a redaction, and a document made from a template keeps the version it was made from. Send the version the change was made from: 409 conflict when a newer one has been saved since. Saving what the newest version already has makes no new version. An archived template is read-only: 409 template_archived until it is restored. A template has at most ${VERSIONS_MAX} versions (409 template_version_limit), the last of which only someone who holds template:redact may save, so that a correction is always possible.` +
          PLACEHOLDERS +
          ' Audited.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(TemplateSave),
        response: { 200: ref(TemplateDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const sent = request.body as TemplateSave;
      // Locked while the versions are compared, so of two saves made from the same version
      // exactly one goes through.
      const template = await findTemplate(request.txClient, request.params.templateId, {
        lock: true,
      });
      if (!template) throw notFound();
      // An archived template is restored before it is given a new version.
      if (template.archived)
        throw new HttpError(409, 'template_archived', 'The template is archived');
      if (template.version !== sent.expectedVersion) {
        throw new HttpError(409, 'conflict', 'A newer version has been saved');
      }
      const newest = await findVersion(request.txClient, template.id, template.version);
      if (!newest) throw notFound();
      const name = sent.name === undefined ? template.name : cleanName(sent.name);
      const body =
        sent.body === undefined
          ? sanitizeRichText(newest.body)
          : cleanBody(template.kind, sent.body);
      const changed = [
        ...(name === template.name ? [] : ['name']),
        ...(sameText(newest.body, body) ? [] : ['body']),
      ];
      // What the newest version already has makes no new version.
      if (changed.length === 0) return detail(request, template);
      const other = await findByName(request.txClient, template.kind, name);
      if (other && other.id !== template.id) throw taken();
      // The last version is kept for whoever may redact: what was typed by mistake into the one
      // before it can then still be replaced, and so removed.
      const policy = await request.access.policy();
      const room = policy?.permissions.some((grant) => grant.permission === REDACT)
        ? VERSIONS_MAX
        : VERSIONS_MAX - 1;
      if (template.version >= room) {
        throw new HttpError(409, 'template_version_limit', 'The template has too many versions');
      }
      try {
        await insertVersion(request.txClient, userOf(request), template, { name, body });
      } catch (error) {
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      request.audit('update', 'template', template.id);
      await request.emit('master.changed', template.id, {
        kind: 'template',
        change: 'updated',
        fields: changed,
        version: template.version + 1,
      });
      const saved = await findTemplate(request.txClient, template.id);
      if (!saved) throw notFound();
      return detail(request, saved);
    },
  );

  app.get(
    '/templates/:templateId/versions/:version',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getTemplateVersion',
        tags: ['templates'],
        description:
          'The name and text of one version of a template, as it was saved. Requires template:read. 404 template_version_not_found for a version it never had. A redacted version answers with an empty name and text, and when, by whom and why it was redacted.' +
          OTHER_HOSPITAL,
        params: VersionParams,
        response: { 200: ref(TemplateVersion), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { templateId, version } = request.params;
      const template = await findTemplate(request.txClient, templateId);
      if (!template) throw notFound();
      const row = await findVersion(request.txClient, template.id, version);
      if (!row) throw versionNotFound();
      return {
        version: row.version,
        savedAt: row.saved_at.toISOString(),
        savedByName: row.saved_by_name,
        name: row.name,
        body: asBody(row.body),
        ...(row.redacted_at === null
          ? {}
          : {
              redactedAt: row.redacted_at.toISOString(),
              ...(row.redacted_by_name === null ? {} : { redactedByName: row.redacted_by_name }),
              ...(row.redaction_reason === null ? {} : { redactionReason: row.redaction_reason }),
            }),
      };
    },
  );

  app.post(
    '/templates/:templateId/versions/:version/redact',
    {
      config: { permissions: [REDACT, READ], feature: FEATURE },
      schema: {
        operationId: 'redactTemplateVersion',
        tags: ['templates'],
        description:
          'Removes the name and the text of one older version of a template, for when something was typed into it that should not be kept: a real patient’s details, say. It is the one change ever made to a saved version, and it cannot be undone. The version stays in the history with its number, who saved it and when, and who redacted it, when and why; the reason is from a list. Requires template:redact and template:read. The newest version is the template as it is used, so it is not redacted (409 template_version_current): save a corrected version first, and restore an archived template to do so. Redacting a version twice changes nothing. A document already made from the version keeps its own text. Audited. 404 template_version_not_found for a version it never had.' +
          OTHER_HOSPITAL,
        params: VersionParams,
        body: ref(TemplateRedact),
        response: { 200: ref(TemplateDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { templateId, version } = request.params;
      const { reason } = request.body as TemplateRedact;
      // Locked, so that a version being saved at the same moment is counted.
      const template = await findTemplate(request.txClient, templateId, { lock: true });
      if (!template) throw notFound();
      if (!(await findVersion(request.txClient, template.id, version))) throw versionNotFound();
      if (version === template.version) {
        throw new HttpError(
          409,
          'template_version_current',
          'The newest version is not redacted: save a corrected version first',
        );
      }
      if (await redactVersion(request.txClient, userOf(request), template.id, version, reason)) {
        request.audit('redact', 'template', template.id);
        await request.emit('master.changed', template.id, {
          kind: 'template_version',
          change: 'redacted',
          version,
          reason,
        });
      }
      return detail(request, template);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    const archive = action === 'archive';
    app.post(
      `/templates/:templateId/${action}`,
      {
        config: { permissions: [MANAGE, READ], feature: FEATURE },
        schema: {
          operationId: archive ? 'archiveTemplate' : 'restoreTemplate',
          tags: ['templates'],
          description:
            (archive
              ? 'Archives a template: it is no longer offered for a new document. Documents made from it keep their text.'
              : 'Brings an archived template back.') +
            ' Requires template:manage and template:read. Doing it twice changes nothing, and neither makes a new version. Audited.' +
            OTHER_HOSPITAL,
          params: Params,
          response: { 200: ref(TemplateDetail), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const template = await findTemplate(request.txClient, request.params.templateId, {
          lock: true,
        });
        if (!template) throw notFound();
        if (template.archived !== archive) {
          await setArchived(request.txClient, template.id, archive);
          request.audit(action, 'template', template.id);
          await request.emit('master.changed', template.id, {
            kind: 'template',
            change: archive ? 'archived' : 'restored',
          });
        }
        return detail(request, { ...template, archived: archive });
      },
    );
  }
};
