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

/** How many rows the handler would move, without changing anything (the merge preview, #603). */
export type PatientMergeCounter = PatientMergeHandler;

export interface PatientMergeRegistry {
  /**
   * `name` is the key of the count kept with the merge, e.g. `documents`. `count` reads how many
   * rows `handler` would move and changes nothing: without it the module is left out of a preview.
   */
  register(name: string, handler: PatientMergeHandler, count?: PatientMergeCounter): void;
  /** What a merge would move, by module name, zero ones left out. Read only. */
  preview(
    client: pg.PoolClient,
    merge: { sourceId: string; targetId: string },
  ): Promise<Record<string, number>>;
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
    const counters = new Map<string, PatientMergeCounter>();
    app.decorate('patientMerge', {
      register(name, handler, count) {
        if (!/^[a-z][a-z_]{0,39}$/.test(name) || handlers.has(name)) {
          throw new Error(`patient_merge_handler_invalid: ${name}`);
        }
        handlers.set(name, handler);
        if (count) counters.set(name, count);
      },
      async preview(client, merge) {
        const counts: Record<string, number> = {};
        for (const [name, count] of counters) {
          const n = await count(client, merge);
          if (n > 0) counts[name] = n;
        }
        return counts;
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
