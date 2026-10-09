// Fails when the API contract changes in a way that breaks existing clients, unless the contract
// version was raised in the same change.
//
//   node scripts/contract-check.mjs <base openapi.json> <new openapi.json>
//
// Breaking: a removed path, operation, success response, schema or schema property; a changed
// property type; a removed enum value; a property that became required. Adding things is fine.
// The version is `info.version` (CONTRACT_VERSION in apps/api/src/core/openapi/plugin.ts): any
// increase counts, and while the major version is 0 a breaking change bumps the minor.
import { readFileSync } from 'node:fs';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** A comparable description of a schema's type, following nothing: refs compare by name. */
function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return `ref:${schema.$ref.split('/').pop()}`;
  // oneOf and anyOf accept the same values wherever the alternatives cannot overlap, which is how
  // they are used here (a schema or null), so swapping one for the other is not a change of type.
  for (const [key, label] of [
    ['oneOf', 'union'],
    ['anyOf', 'union'],
    ['allOf', 'allOf'],
  ]) {
    if (Array.isArray(schema[key])) return `${label}(${schema[key].map(typeOf).sort().join('|')})`;
  }
  if (schema.type === 'array') return `array<${typeOf(schema.items)}>`;
  if (Array.isArray(schema.type)) return [...schema.type].sort().join('|');
  return schema.type ?? (schema.const !== undefined ? typeof schema.const : 'unknown');
}

const enumOf = (schema) => (schema?.const !== undefined ? [schema.const] : (schema?.enum ?? null));

function compareSchema(name, before, after, breaking) {
  const was = before.properties ?? {};
  const now = after.properties ?? {};
  for (const [property, schema] of Object.entries(was)) {
    const at = `${name}.${property}`;
    if (!(property in now)) {
      breaking.push(`Property ${at} was removed.`);
      continue;
    }
    if (typeOf(schema) !== typeOf(now[property])) {
      breaking.push(
        `Property ${at} changed type from ${typeOf(schema)} to ${typeOf(now[property])}.`,
      );
    }
    const oldEnum = enumOf(schema);
    const newEnum = enumOf(now[property]);
    if (oldEnum && newEnum) {
      for (const value of oldEnum) {
        if (!newEnum.includes(value)) breaking.push(`Value "${value}" was removed from ${at}.`);
      }
    }
    // One level of nesting covers inline objects such as Tenant.theme and Error.error.
    if (schema.properties && now[property].properties) {
      compareSchema(at, schema, now[property], breaking);
    }
  }
  const wasRequired = new Set(before.required ?? []);
  for (const property of after.required ?? []) {
    if (!wasRequired.has(property) && property in was) {
      breaking.push(`Property ${name}.${property} became required.`);
    }
  }
}

/** Every breaking difference between two OpenAPI documents, as sentences. */
export function findBreakingChanges(before, after) {
  const breaking = [];
  for (const [path, item] of Object.entries(before.paths ?? {})) {
    const next = after.paths?.[path];
    if (!next) {
      breaking.push(`Path ${path} was removed.`);
      continue;
    }
    for (const method of METHODS) {
      if (!item[method]) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!next[method]) {
        breaking.push(`Operation ${label} was removed.`);
        continue;
      }
      for (const status of Object.keys(item[method].responses ?? {})) {
        if (/^2/.test(status) && !next[method].responses?.[status]) {
          breaking.push(`Response ${status} of ${label} was removed.`);
        }
      }
      const wasRequired = (item[method].parameters ?? []).filter((p) => p.required);
      for (const parameter of (next[method].parameters ?? []).filter((p) => p.required)) {
        const existed = wasRequired.some((p) => p.name === parameter.name && p.in === parameter.in);
        if (!existed) {
          breaking.push(`${label} now requires the ${parameter.in} parameter "${parameter.name}".`);
        }
      }
    }
  }
  for (const [name, schema] of Object.entries(before.components?.schemas ?? {})) {
    const next = after.components?.schemas?.[name];
    if (!next) breaking.push(`Schema ${name} was removed.`);
    else compareSchema(name, schema, next, breaking);
  }
  return breaking;
}

const parse = (version) =>
  String(version ?? '0.0.0')
    .split('.')
    .map((part) => Number(part) || 0);

/** True when `after` is a higher version than `before`. */
export function versionRaised(before, after) {
  const [a, b] = [parse(before), parse(after)];
  for (let index = 0; index < 3; index++) {
    if ((b[index] ?? 0) !== (a[index] ?? 0)) return (b[index] ?? 0) > (a[index] ?? 0);
  }
  return false;
}

/** Whether a version change is big enough for a breaking change: major, or minor while 0.x. */
export function versionCoversBreaking(before, after) {
  const [a, b] = [parse(before), parse(after)];
  if (b[0] > a[0]) return true;
  return a[0] === 0 && b[0] === 0 && b[1] > a[1];
}

if (
  process.argv[1] &&
  import.meta.url.endsWith('/contract-check.mjs') &&
  process.argv.length >= 4
) {
  const [beforePath, afterPath] = process.argv.slice(2);
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const breaking = findBreakingChanges(before, after);
  const from = before.info?.version;
  const to = after.info?.version;

  if (breaking.length === 0) {
    console.log(`Contract ${to}: no breaking changes against ${from}.`);
    process.exit(0);
  }
  console.log(`Breaking contract changes (${from} -> ${to}):`);
  for (const change of breaking) console.log(`- ${change}`);
  if (versionCoversBreaking(from, to)) {
    console.log('The contract version was raised, so these are accepted.');
    process.exit(0);
  }
  console.error(
    '::error::The API contract has breaking changes but its version was not raised enough. ' +
      'Raise CONTRACT_VERSION (major, or minor while it is 0.x) in apps/api/src/core/openapi/plugin.ts, ' +
      'run pnpm gen:api, and update the web app in the same PR.',
  );
  process.exit(1);
}
