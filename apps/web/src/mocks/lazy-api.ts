import { getResponse, http, isPassthroughResponse, passthrough } from 'msw';
import type { RequestHandler } from 'msw';
import { handlerGroups } from './handler-groups';

const loaded = new Map<string, Promise<readonly RequestHandler[]>>();

function loadGroup(name: string, load: () => Promise<readonly RequestHandler[]>) {
  let pending = loaded.get(name);
  if (!pending) {
    pending = load();
    loaded.set(name, pending);
  }
  return pending;
}

async function everything(): Promise<readonly RequestHandler[]> {
  return (await Promise.all(handlerGroups.map((g) => loadGroup(g.name, g.load)))).flat();
}

/**
 * Handlers of the files that answer a first path segment, in the order the whole list has them.
 * An unknown segment, or one whose files answer nothing, falls back to the whole list, so a
 * file missing from `segments` costs time and never a wrong answer.
 */
async function handlersFor(segment: string | undefined) {
  const groups = handlerGroups.filter((g) => segment && g.segments.includes(segment));
  if (groups.length === 0) return everything();
  return (await Promise.all(groups.map((g) => loadGroup(g.name, g.load)))).flat();
}

/**
 * One handler that stands for every feature handler of the mock (#1176). Building the several
 * hundred handler objects cost about 220 ms at the phone's throttle before the first render, and
 * MSW walks the whole list for each API request. This one reads the request's first path
 * segment, loads and builds only the files that answer it, and hands the request to them.
 */
export const lazyApi = http.all(/\/api\//, async ({ request }) => {
  const segment = /\/api\/([^/?#]*)/.exec(new URL(request.url).pathname + '/')?.[1];
  const run = (handlers: readonly RequestHandler[]) =>
    getResponse(handlers as never, request.clone());
  let response = await run(await handlersFor(segment));
  if (!response) {
    const all = await everything();
    response = await run(all);
  }
  if (!response || isPassthroughResponse(response)) return passthrough();
  return response;
});
