import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ErrorBody } from './errors.js';

/**
 * Refers to a schema registered with `app.addSchema` by its `$id`, keeping its static type.
 *
 * A schema used through `ref` appears once in the OpenAPI contract, under
 * `components.schemas.<$id>`, and the generated client gets a named type for it. Register a
 * schema that several routes share, or that the web app needs by name, and use it this way.
 */
export function ref<T extends TSchema>(schema: T) {
  if (typeof schema.$id !== 'string') {
    throw new Error('ref() needs a schema with an $id that was registered with app.addSchema');
  }
  return Type.Unsafe<Static<T>>({ $ref: `${schema.$id}#` });
}

/**
 * Error responses for a route's `response` map. Every error uses the one standard body:
 *
 *   response: { 200: ref(Patient), ...errors(401, 403, 404) }
 */
export function errors<Status extends number>(...statuses: Status[]) {
  const body = ref(ErrorBody);
  return Object.fromEntries(statuses.map((status) => [status, body])) as Record<
    Status,
    typeof body
  >;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Query parameters of every list endpoint. Lists are always paginated by cursor: there is no
 * way to ask for "everything".
 */
export const CursorQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
});
export type CursorQuery = Static<typeof CursorQuery>;

/**
 * The envelope of every list endpoint: `{ items, nextCursor, total? }`. `nextCursor` is null on
 * the last page. `total` is optional because counting a large table is not always worth it.
 *
 *   const PatientPage = CursorPage(ref(Patient), { $id: 'PatientPage' });
 */
export function CursorPage<T extends TSchema>(item: T, options: { $id: string }) {
  return Type.Object(
    {
      items: Type.Array(item),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
      total: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { ...options, description: 'Cursor envelope used by every list endpoint.' },
  );
}

/** Schemas registered once for the whole app. Features register their own in their plugin. */
export const SHARED_SCHEMAS = [ErrorBody] as const;
