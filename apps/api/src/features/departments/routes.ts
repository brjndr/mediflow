import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  insertDepartment,
  isNameTaken,
  listDepartments,
  lockDepartment,
  nameTaken,
  setArchived,
  updateDepartment,
  type DepartmentRow,
} from './repository.js';
import {
  Department,
  DEPARTMENT_SCHEMAS,
  DepartmentCreate,
  DepartmentListQuery,
  DepartmentPage,
  DepartmentUpdate,
  DESCRIPTION_MAX,
  NAME_MAX,
} from './schemas.js';

const FEATURE = 'departments';
const READ = 'department:read';
const MANAGE = 'department:manage';

const view = (row: DepartmentRow): Department => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  archived: row.archived,
  version: row.version,
});

// One answer for a department that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'department_not_found', 'No such department');
const taken = () =>
  new HttpError(409, 'department_name_taken', 'This hospital has a department of that name');

/** A name as it is stored, and not empty once it is tidied. */
function cleanName(name: string): string {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw new HttpError(400, 'validation_failed', 'A name is required');
  return tidied;
}

/** An empty description is no description. */
const cleanDescription = (description: string | undefined): string | null =>
  tidyLinesOptional(description, DESCRIPTION_MAX);

const OTHER_HOSPITAL =
  ' A department of another hospital answers 404 department_not_found, the same as one that does not exist.';

export const departmentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DEPARTMENT_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ departmentId: Type.String({ maxLength: 64 }) });

  app.get(
    '/departments',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listDepartments',
        tags: ['departments'],
        description:
          'Departments of the active tenant, by name. Archived departments are listed only when asked for. `total` comes with the first page.',
        querystring: DepartmentListQuery,
        response: { 200: ref(DepartmentPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      const list = await listDepartments(request.txClient, { archived, cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(view),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/departments',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createDepartment',
        tags: ['departments'],
        headers: IdempotencyHeaders,
        description:
          "Adds a department. The hospital is the session's: the body carries no tenant. A name already used by a department of the hospital, archived or not, whatever its capitals, is refused with 409 department_name_taken.",
        body: ref(DepartmentCreate),
        response: { 201: ref(Department), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as DepartmentCreate;
      const name = cleanName(body.name);
      if (await nameTaken(request.txClient, name)) throw taken();
      let row: DepartmentRow;
      try {
        row = await insertDepartment(request.txClient, {
          name,
          description: cleanDescription(body.description),
        });
      } catch (error) {
        // Two requests for the same new name at once: the database lets one through.
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      request.audit('create', 'department', row.id);
      return reply.status(201).send(view(row));
    },
  );

  app.patch(
    '/departments/:departmentId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'updateDepartment',
        tags: ['departments'],
        description:
          'Changes a department. Send the version the change was made from: 409 conflict when the department has changed since, 409 department_name_taken for a name in use. Sending what the department already has changes nothing.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(DepartmentUpdate),
        response: { 200: ref(Department), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DepartmentUpdate;
      // Locked while the versions are compared, so of two changes made from the same version
      // exactly one goes through.
      const current = await lockDepartment(request.txClient, request.params.departmentId);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The department has changed');
      }
      const name = body.name === undefined ? current.name : cleanName(body.name);
      const description =
        body.description === undefined ? current.description : cleanDescription(body.description);
      if (name === current.name && description === current.description) return view(current);
      // The database decides what "the same name" is (its lower-casing is not JavaScript's), and
      // a department is never in the way of its own name.
      if (name !== current.name && (await nameTaken(request.txClient, name, current.id))) {
        throw taken();
      }
      let row: DepartmentRow;
      try {
        row = await updateDepartment(request.txClient, current.id, { name, description });
      } catch (error) {
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      request.audit('update', 'department', row.id);
      return view(row);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/departments/:departmentId/${action}`,
      {
        config: { permissions: [MANAGE], feature: FEATURE },
        schema: {
          operationId: `${action}Department`,
          tags: ['departments'],
          description:
            (action === 'archive'
              ? 'Archives a department: it stays on the records that name it and is no longer offered for new ones.'
              : 'Brings an archived department back.') +
            ' Doing it twice changes nothing.' +
            OTHER_HOSPITAL,
          params: Params,
          response: { 200: ref(Department), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const current = await lockDepartment(request.txClient, request.params.departmentId);
        if (!current) throw notFound();
        const changed = await setArchived(request.txClient, current.id, action === 'archive');
        if (changed) request.audit(action, 'department', changed.id);
        return view(changed ?? current);
      },
    );
  }
};
