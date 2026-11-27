import fp from 'fastify-plugin';
import type pg from 'pg';

/**
 * What a module holds on a visit that stops it being cancelled (#1223): billing, a file, a
 * booking. A hold sees ids only, and runs in the request's transaction with the visit locked, so
 * whatever adds to a visit (it reads the row `for share`, #1222) is either seen or refused.
 */
export type VisitHold = (client: pg.ClientBase, encounterId: string) => Promise<boolean>;

export interface VisitHolds {
  register(name: string, hold: VisitHold): void;
  /** Whether any module, or the hold named, holds something on the visit. */
  standing(client: pg.ClientBase, encounterId: string, name?: string): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyInstance {
    visitHolds: VisitHolds;
  }
}

/** Where a module declares what it holds on a visit without the clinical module knowing it. */
export const visitHoldsPlugin = fp(
  async (app) => {
    const holds = new Map<string, VisitHold>();
    app.decorate('visitHolds', {
      register(name, hold) {
        if (holds.has(name)) throw new Error(`visit_hold_twice: ${name}`);
        holds.set(name, hold);
      },
      async standing(client, encounterId, name) {
        if (name !== undefined) {
          const named = holds.get(name);
          // A misspelt name must never read as "nothing stands".
          if (!named) throw new Error(`visit_hold_unknown: ${name}`);
          return named(client, encounterId);
        }
        for (const hold of holds.values()) {
          if (await hold(client, encounterId)) return true;
        }
        return false;
      },
    } satisfies VisitHolds);
  },
  { name: 'visit-holds' },
);
