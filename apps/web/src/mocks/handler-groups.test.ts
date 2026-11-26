import { setupServer } from 'msw/node';
import { coreHandlers, notTheApi } from './core-handlers';
import { handlerGroups } from './handler-groups';
import { handlers } from './handlers';
import { lazyApi } from './lazy-api';

const segmentOf = (handler: unknown) => {
  const path = String((handler as { info: { path: unknown } }).info.path);
  return /\/api\/([^/]*)/.exec(path)?.[1] ?? /^\*\/([^/]*)/.exec(path)?.[1];
};

describe('lazy mock handlers (#1176)', () => {
  it('names every first path segment that a handler file answers', async () => {
    for (const group of handlerGroups) {
      for (const handler of await group.load()) {
        expect(group.segments, `${group.name}: ${String(segmentOf(handler))}`).toContain(
          segmentOf(handler),
        );
      }
    }
  });

  it('holds every feature handler of the whole list, in the same order', async () => {
    const all = (await Promise.all(handlerGroups.map((g) => g.load()))).flat();
    expect(all).toEqual(handlers.slice(1 + coreHandlers.length));
  });

  it('answers an API request through the lazy handler, and leaves other requests alone', async () => {
    const server = setupServer(notTheApi, ...coreHandlers, lazyApi);
    server.listen();
    try {
      const res = await fetch('http://localhost:3000/api/departments');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
      const health = await fetch('http://localhost:3000/api/health');
      expect(health.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
