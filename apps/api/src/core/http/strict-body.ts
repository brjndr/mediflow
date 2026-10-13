import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

/**
 * A JSON body carries its own types, and they are checked as sent.
 *
 * The validator coerces types, which query strings and path parameters need because they are
 * text. In a body the same coercion turned a `null` sent for a number into 0, `true` into 1 and a
 * `null` sent for a boolean into false, silently and before any handler ran: a null price became
 * a price of 0. This hook runs before validation and refuses (400 `validation_failed`) a body in
 * which a number, an integer, a boolean, a string, an object or an array was sent as something
 * else. Where the schema itself allows null, null passes. Everything else about a body (ranges,
 * lengths, required fields, unknown fields) is still the validator's.
 */

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a value, exactly as it was sent, is of a JSON Schema type. */
function isOfType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      // A type this hook does not know is left to the validator.
      return true;
  }
}

/**
 * The path of the first value whose type is not the one its schema declares, or null when every
 * value is as declared. A path names fields of the schema, never a value that was sent.
 */
export function wrongType(
  schema: unknown,
  value: unknown,
  resolve: (id: string) => unknown,
  path = 'body',
  depth = 0,
): string | null {
  // Deeper than any schema of this API: stop, and let the validator decide.
  if (!isObject(schema) || depth > 32) return null;
  const node: Schema = schema;

  if (typeof node.$ref === 'string') {
    return wrongType(resolve(node.$ref.replace(/#$/, '')), value, resolve, path, depth + 1);
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      // One of several schemas: fine when the value is as one of them declares.
      const fits = branches.some(
        (branch) => wrongType(branch, value, resolve, path, depth + 1) === null,
      );
      return fits ? null : path;
    }
  }

  const types =
    typeof node.type === 'string'
      ? [node.type]
      : Array.isArray(node.type)
        ? node.type.filter((type): type is string => typeof type === 'string')
        : [];
  if (types.length > 0 && !types.some((type) => isOfType(type, value))) return path;

  if (isObject(value) && isObject(node.properties)) {
    for (const [name, property] of Object.entries(node.properties)) {
      if (!(name in value)) continue;
      const found = wrongType(property, value[name], resolve, `${path}.${name}`, depth + 1);
      if (found) return found;
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const found = wrongType(node.items, item, resolve, `${path}.${index}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Registers the check for every route that declares a body schema. Call it before any route. */
export function registerStrictBodies(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    const schema = request.routeOptions.schema?.body;
    // No schema: nothing is declared. No body: a required one is the validator's to refuse.
    if (schema === undefined || request.body === undefined) return;
    // A feature registers its schemas in its own plugin, and only that instance knows them.
    const path = wrongType(schema, request.body, (id) => request.server.getSchema(id));
    if (path) {
      throw new HttpError(
        400,
        'validation_failed',
        `${path} is not of the type the request declares for it`,
      );
    }
  });
}
