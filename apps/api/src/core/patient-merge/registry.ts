import fp from 'fastify-plugin';
import type pg from 'pg';

/**
 * What a module does with its own rows when two patient records are merged (#194). The merge runs
 * in the request's transaction, so a handler either moves everything or the whole merge is undone.
 * It runs after the source record points at the survivor, so a database guard may check that.
 * A handler returns how many rows it moved: counts are kept with the merge, never values.
 */
export type PatientMergeHandler = (
  client: pg.PoolClient,
  merge: { sourceId: string; targetId: string },
) => Promise<number>;

export interface PatientMergeRegistry {
  /** `name` is the key of the count kept with the merge, e.g. `documents`. */
  register(name: string, handler: PatientMergeHandler): void;
  /** Runs every handler in the order registered; the counts by name, zero ones left out. */
  run(
    client: pg.PoolClient,
    merge: { sourceId: string; targetId: string },
  ): Promise<Record<string, number>>;
}

declare module 'fastify' {
  interface FastifyInstance {
    patientMerge: PatientMergeRegistry;
  }
}

export const patientMergePlugin = fp(
  async (app) => {
    const handlers = new Map<string, PatientMergeHandler>();
    app.decorate('patientMerge', {
      register(name, handler) {
        if (!/^[a-z][a-z_]{0,39}$/.test(name) || handlers.has(name)) {
          throw new Error(`patient_merge_handler_invalid: ${name}`);
        }
        handlers.set(name, handler);
      },
      async run(client, merge) {
        const moved: Record<string, number> = {};
        for (const [name, handler] of handlers) {
          const count = await handler(client, merge);
          if (count > 0) moved[name] = count;
        }
        return moved;
      },
    } satisfies PatientMergeRegistry);
  },
  { name: 'patient-merge' },
);
