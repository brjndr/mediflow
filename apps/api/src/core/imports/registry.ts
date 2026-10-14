import type { TObject } from '@sinclair/typebox';
import fp from 'fastify-plugin';
import type pg from 'pg';
import type { Permission } from '../access/registry.js';
import type { DomainEvent } from '../outbox/events.js';

/**
 * What a create function writes through. A request is one (its transaction, its audit and its
 * outbox), and so is the import job, so the route and the import write a record the same way.
 */
export interface Writer {
  txClient: pg.PoolClient;
  audit(action: string, entity: string, entityId?: string): void;
  emit(event: DomainEvent, entityId: string, payload?: Record<string, unknown>): Promise<void>;
}

/** How the text of a column becomes the value of its field. */
export type ColumnType =
  | { type: 'text' }
  | { type: 'integer' }
  | { type: 'boolean' }
  /** One of a fixed list, whatever its capitals. */
  | { type: 'enum'; values: readonly string[] }
  /** A calendar date, YYYY-MM-DD. */
  | { type: 'date' }
  /** An amount in the hospital's currency, with a point before the minor units: minor units. */
  | { type: 'amount' };

export type ImportColumn = ColumnType & {
  /** The field of the body it fills, which is also its name in a mapping. */
  field: string;
  required: boolean;
};

/**
 * What is wrong with one field of a row, thrown by `prepare` when it can say which field. An
 * `HttpError` thrown instead is a problem of the whole row, with its code.
 */
export class RowProblem extends Error {
  constructor(
    readonly field: string,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RowProblem';
  }
}

/** One row as a create body, checked and ready to write. */
export interface Prepared<T> {
  value: T;
  /** Two rows with the same key are the same record: the second is a duplicate within the file. */
  key: string;
}

/**
 * A kind of record the import centre can load, registered by the feature that owns it. It checks
 * a row the way that feature's create route checks a request, and writes it the way the route
 * does, so an imported record is no different from one added on its screen.
 */
export interface ImportKind<T = unknown> {
  /** The name of the kind in the API and the web app: `services`. */
  kind: string;
  /** The module flag the kind belongs to: the hospital must have it on. */
  feature: string;
  /** What the caller must hold, besides `import:run`, to load this kind. */
  permissions: readonly Permission[];
  columns: readonly ImportColumn[];
  /** The create body, against which a row is validated before `prepare` sees it. */
  body: TObject;
  /**
   * Checks a valid body and makes what is written, reading only: throws `HttpError` (its code
   * becomes the row's problem) for a row that cannot be written. The dry run calls only this.
   */
  prepare(writer: Writer, body: Record<string, unknown>): Promise<Prepared<T>>;
  /**
   * Writes what `prepare` made, audited and announced as the create route does it. `actorId` is
   * who asked for the batch to be written.
   */
  write(writer: Writer, value: T, actorId: string): Promise<void>;
}

export interface ImportKinds {
  register<T>(kind: ImportKind<T>): void;
  get(kind: string): ImportKind | undefined;
  all(): ImportKind[];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The kinds of record the import centre can load. Features add theirs as they register. */
    importKinds: ImportKinds;
  }
}

/**
 * Where features declare what can be imported into them. The import centre (features/imports)
 * knows no kind of its own: a new catalog becomes importable by registering one here.
 */
export const importKindsPlugin = fp(
  async (app) => {
    const kinds = new Map<string, ImportKind>();
    app.decorate('importKinds', {
      register<T>(kind: ImportKind<T>) {
        if (kinds.has(kind.kind)) throw new Error(`Import kind ${kind.kind} is registered twice`);
        kinds.set(kind.kind, kind as ImportKind);
      },
      get: (kind: string) => kinds.get(kind),
      all: () => [...kinds.values()],
    });
  },
  { name: 'import-kinds' },
);
