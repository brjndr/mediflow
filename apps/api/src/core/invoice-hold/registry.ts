import fp from 'fastify-plugin';
import type pg from 'pg';

/**
 * What a module holds against a split pair of invoices that stops it being discarded (#1240): a
 * claim made to the payer. A hold sees ids only, and runs in the request's transaction with the
 * visit locked for update, so whatever it looks for (made while holding the visit `for share`)
 * is either seen or made afterwards.
 */
export type SplitHold = (
  client: pg.ClientBase,
  split: { encounterId: string; payerId: string },
) => Promise<boolean>;

export interface SplitHolds {
  register(name: string, hold: SplitHold): void;
  /** Whether any module holds something against the visit's split with this payer. */
  standing(
    client: pg.ClientBase,
    split: { encounterId: string; payerId: string },
  ): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyInstance {
    splitHolds: SplitHolds;
  }
}

/** Where a module declares what depends on a split pair without billing knowing it. */
export const splitHoldsPlugin = fp(
  async (app) => {
    const holds = new Map<string, SplitHold>();
    app.decorate('splitHolds', {
      register(name, hold) {
        if (holds.has(name)) throw new Error(`split_hold_twice: ${name}`);
        holds.set(name, hold);
      },
      async standing(client, split) {
        for (const hold of holds.values()) {
          if (await hold(client, split)) return true;
        }
        return false;
      },
    } satisfies SplitHolds);
  },
  { name: 'split-holds' },
);
