import pg from 'pg';

/** What a live message says: ids and codes only, never patient data. */
export type LiveData = Record<string, string>;

export interface LiveListener {
  message(data: LiveData): void;
  /** Delivery broke: messages may have been missed, so whatever follows them must start again. */
  lost(): void;
}

/**
 * Tells open screens that something changed, across every API instance. Phase 1 is Postgres
 * `LISTEN`/`NOTIFY` (`PgLiveBus`); Redis pub/sub can replace it behind this interface.
 */
export interface LiveBus {
  /**
   * Publishes in `client`'s transaction, so the message goes out when it commits and never when
   * it rolls back. The hospital is the transaction's own, never an argument.
   */
  publish(client: pg.ClientBase, topic: string, data: LiveData): Promise<void>;
  /**
   * Listens to one hospital's topic. Resolves once listening, so nothing committed after that is
   * missed, with the function that stops it.
   */
  subscribe(tenantId: string, topic: string, listener: LiveListener): Promise<() => void>;
  close(): Promise<void>;
}

const CHANNEL = 'mediflow_live';
/** How long connecting, or a heartbeat query, may take before the connection counts as lost. */
const CONNECT_TIMEOUT_MS = 5_000;
/** How often the listening connection is asked whether it is still there. */
const HEARTBEAT_MS = 20_000;

interface Notice {
  t: string;
  k: string;
  d: LiveData;
}

function parseNotice(payload: string | undefined): Notice | null {
  try {
    const value: unknown = JSON.parse(payload ?? '');
    if (typeof value !== 'object' || value === null) return null;
    const { t, k, d } = value as Record<string, unknown>;
    if (typeof t !== 'string' || typeof k !== 'string') return null;
    if (typeof d !== 'object' || d === null) return null;
    return { t, k, d: d as LiveData };
  } catch {
    return null;
  }
}

/**
 * Postgres `NOTIFY` on one channel for every hospital, and one connection per API instance that
 * `LISTEN`s to it, opened when the first stream subscribes. A message carries its hospital, set
 * in SQL from the publishing transaction, and is handed only to that hospital's listeners. When
 * the connection fails every listener is told it was lost, and the next subscription opens a new
 * one.
 */
export class PgLiveBus implements LiveBus {
  private readonly listeners = new Map<string, Set<LiveListener>>();
  private connection: Promise<pg.Client> | null = null;
  private closed = false;
  private heartbeat: NodeJS.Timeout | undefined = undefined;

  constructor(private readonly connectionString: string) {}

  async publish(client: pg.ClientBase, topic: string, data: LiveData): Promise<void> {
    await client.query(
      `select pg_notify($1, json_build_object('t', app_tenant_id(), 'k', $2::text, 'd', $3::jsonb)::text)
       where app_tenant_id() is not null`,
      [CHANNEL, topic, JSON.stringify(data)],
    );
  }

  async subscribe(tenantId: string, topic: string, listener: LiveListener): Promise<() => void> {
    if (this.closed) throw new Error('The live bus is closed');
    const connection = this.listen();
    await connection;
    // Closed, or the connection lost, while it was opening: whatever came then was missed.
    if (this.closed) throw new Error('The live bus is closed');
    if (this.connection !== connection) throw new Error('The live bus lost its connection');
    const key = `${tenantId}:${topic}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = null;
    clearInterval(this.heartbeat);
    this.loseAll();
    if (connection) await (await connection.catch(() => null))?.end().catch(() => undefined);
  }

  private listen(): Promise<pg.Client> {
    this.connection ??= this.connect();
    return this.connection;
  }

  // Not async: the promise kept in `connection` must be `attempt` itself, which `lose` compares.
  private connect(): Promise<pg.Client> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      // A connection the network dropped without a word is noticed by the operating system too.
      keepAlive: true,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    const attempt = (async () => {
      client.on('notification', (notification) => {
        const notice = parseNotice(notification.payload);
        if (!notice) return;
        for (const listener of [...(this.listeners.get(`${notice.t}:${notice.k}`) ?? [])]) {
          listener.message(notice.d);
        }
      });
      const fail = () => this.lose(attempt);
      client.on('error', fail);
      client.on('end', fail);
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
      // A half-open connection never says it is gone: a query that does not answer does.
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('no answer')), CONNECT_TIMEOUT_MS).unref();
        });
        void Promise.race([client.query('select 1'), timeout]).catch(fail);
      }, HEARTBEAT_MS);
      this.heartbeat.unref();
      return client;
    })();
    attempt.catch(() => {
      if (this.connection === attempt) this.connection = null;
      void client.end().catch(() => undefined);
    });
    return attempt;
  }

  /** The listening connection broke: every listener may have missed messages. */
  private lose(connection: Promise<pg.Client>): void {
    if (this.connection !== connection) return;
    this.connection = null;
    clearInterval(this.heartbeat);
    void connection.then((client) => client.end()).catch(() => undefined);
    this.loseAll();
  }

  private loseAll(): void {
    const all = [...this.listeners.values()].flatMap((set) => [...set]);
    this.listeners.clear();
    for (const listener of all) listener.lost();
  }
}
