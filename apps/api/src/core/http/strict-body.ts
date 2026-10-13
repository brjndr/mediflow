import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

/**
 * A JSON body carries its own types, and they are checked as sent.
 *
 * The validator coerces types, which query strings and path parameters need because they are
 * text. In a body the same coercion turned a `null` sent for a number into 0, `true` into 1 and a
 * `null` sent for a text into the empty text, silently and before any handler ran: a null price
 * became a price of 0. This hook runs before validation and refuses (400 `validation_failed`) a
 * body in which a number, an integer, a boolean, a string, an object or an array was sent as
 * something else. Where the schema itself allows null, null passes. Everything else about a body
 * (ranges, lengths, required fields, unknown fields) is still the validator's.
 *
 * It can only hold for a schema it can follow, so a body schema is made of what it follows:
 * `type` (one or several), `properties`, `items` as one schema, and a `$ref` to a registered
 * schema. A route whose body schema uses anything else stops the app from starting, as a tenant
 * route without `permissions` does. A union (`anyOf`, `oneOf`) is among what is refused: both of
 * its types pass this check, and the validator then coerces the value to the first branch, so a
 * value that may be null is one schema with both types, `{ type: ['integer', 'null'] }`.
 */

type Schema = Record<string, unknown>;
type Resolve = (id: string) => unknown;

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
      return false;
  }
}

const KNOWN_TYPES = ['null', 'number', 'integer', 'boolean', 'string', 'array', 'object'];

/** Keywords that hold a schema this module does not follow into. */
const NOT_FOLLOWED = [
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'prefixItems',
  'contains',
  'dependentSchemas',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  '$defs',
  'definitions',
];

const refId = (ref: string) => ref.replace(/#$/, '');

const typesOf = (node: Schema): string[] =>
  typeof node.type === 'string'
    ? [node.type]
    : Array.isArray(node.type)
      ? node.type.filter((type): type is string => typeof type === 'string')
      : [];

/**
 * Why a body schema cannot be followed, or null when it can. Checked once per route, when the
 * route is registered.
 */
export function notFollowable(
  schema: unknown,
  resolve: Resolve,
  path = 'body',
  inside: readonly string[] = [],
): string | null {
  if (!isObject(schema)) return `${path} is not a schema`;
  const node: Schema = schema;

  if (typeof node.$ref === 'string') {
    const id = refId(node.$ref);
    if (id === '' || id.includes('/')) return `${path} refers to a part of a schema (${node.$ref})`;
    if (inside.includes(id)) return `${path} refers back to ${id}, which contains it`;
    const target = resolve(id);
    if (target === undefined) return `${path} refers to ${id}, which is not registered`;
    return notFollowable(target, resolve, path, [...inside, id]);
  }
  for (const keyword of NOT_FOLLOWED) {
    if (keyword in node) return `${path} uses ${keyword}`;
  }
  const types = typesOf(node);
  const unknown = types.find((type) => !KNOWN_TYPES.includes(type));
  if (unknown) return `${path} has the type ${unknown}`;
  // A value with no type is not coerced (an enum, a const), and is the validator's alone.
  if (types.length === 0 && ('properties' in node || 'items' in node)) {
    return `${path} has properties or items and no type`;
  }
  if (isObject(node.additionalProperties)) return `${path} gives a schema for unnamed properties`;

  if (node.properties !== undefined) {
    if (!isObject(node.properties)) return `${path}.properties is not a map of schemas`;
    for (const [name, property] of Object.entries(node.properties)) {
      const problem = notFollowable(property, resolve, `${path}.${name}`, inside);
      if (problem) return problem;
    }
  }
  if (node.items !== undefined) {
    if (!isObject(node.items)) return `${path} has a list of schemas for its items`;
    return notFollowable(node.items, resolve, `${path}[]`, inside);
  }
  return null;
}

/**
 * The path of the first value whose type is not one its schema declares, or null when every
 * value is as declared. A path names fields of the schema, never a value that was sent. The
 * schema is one `notFollowable` passed.
 */
export function wrongType(
  schema: unknown,
  value: unknown,
  resolve: Resolve,
  path = 'body',
): string | null {
  if (!isObject(schema)) return null;
  const node: Schema = schema;
  if (typeof node.$ref === 'string') {
    return wrongType(resolve(refId(node.$ref)), value, resolve, path);
  }
  const types = typesOf(node);
  if (types.length > 0 && !types.some((type) => isOfType(type, value))) return path;

  if (isObject(value) && isObject(node.properties)) {
    for (const [name, property] of Object.entries(node.properties)) {
      // Its own fields only: every object has a `toString`.
      if (!Object.hasOwn(value, name)) continue;
      const found = wrongType(property, value[name], resolve, `${path}.${name}`);
      if (found) return found;
    }
  }
  if (Array.isArray(value) && isObject(node.items)) {
    for (const [index, item] of value.entries()) {
      const found = wrongType(node.items, item, resolve, `${path}.${index}`);
      if (found) return found;
    }
  }
  return null;
}

/** Registers the check for every route that declares a body schema. Call it before any route. */
export function registerStrictBodies(app: FastifyInstance): void {
  // `this` is the instance the route is registered on: a feature registers its schemas in its
  // own plugin, and only that instance knows them.
  app.addHook('onRoute', function (this: FastifyInstance, route) {
    const schema = route.schema?.body;
    if (schema === undefined) return;
    const problem = notFollowable(schema, (id) => this.getSchema(id));
    if (problem) {
      throw new Error(
        `${String(route.method)} ${route.url}: the types of its body cannot be checked, because ${problem}. See core/http/strict-body.ts.`,
      );
    }
  });

  app.addHook('preValidation', async (request) => {
    const schema = request.routeOptions.schema?.body;
    // No schema: nothing is declared. No body: a required one is the validator's to refuse.
    if (schema === undefined || request.body === undefined) return;
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
