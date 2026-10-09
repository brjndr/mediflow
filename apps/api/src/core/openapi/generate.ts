// Writes the OpenAPI document built from the route schemas to packages/contract/api.openapi.json.
// Run through `pnpm gen:api` from the repo root, which then merges it with the planned endpoints
// and regenerates the web app's types. Needs no database: the app is built but never queried.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../app.js';
import { loadConfig } from '../config/config.js';

const OUTPUT = fileURLToPath(
  new URL('../../../../../packages/contract/api.openapi.json', import.meta.url),
);

const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
await app.ready();
const document = app.swagger();
await app.close();

writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`Wrote ${Object.keys(document.paths ?? {}).length} paths to ${OUTPUT}\n`);
