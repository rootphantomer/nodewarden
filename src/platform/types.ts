/**
 * Platform abstraction layer.
 *
 * NodeWarden runs natively on Cloudflare Workers, but tickets like
 * "port to Tencent EdgeOne Makers / Aliyun FC" require the platform-specific
 * capabilities (D1, Durable Objects, R2/KV bindings) to sit behind narrow
 * ports. Each port keeps a Cloudflare default implementation that is
 * behavior-identical to the pre-refactor code paths, plus an alternative
 * implementation for platforms without the corresponding binding.
 */

export type SqlValue = null | string | number | boolean | ArrayBuffer | ArrayBufferView;

export type SqlEngine = 'd1' | 'mysql';

export interface SqlQueryMeta {
  [key: string]: any;
}

/** Result shape mirroring `D1Result`: `results` plus execution metadata. */
export interface SqlQueryResult<Results> {
  results: Results;
  success: boolean;
  meta: SqlQueryMeta;
}

/**
 * Prepared statement subset that the whole data layer relies on
 * (`prepare`/`bind`/`run`/`all`/`first`, plus `batch`). Anything beyond this
 * subset is intentionally unsupported so alternative SQL backends can
 * implement the same surface.
 */
export interface SqlStatement<Values extends readonly unknown[] = readonly unknown[]> {
  bind(...values: Values): SqlStatement;
  first<T = Record<string, any>>(colName?: string): Promise<T | null>;
  all<T = Record<string, any>>(): Promise<SqlQueryResult<T[]>>;
  run(): Promise<SqlQueryResult<Record<string, any>[]>>;
}

export interface SqlDatabase {
  /** Backend engine tag; schema bootstrap branches on it. D1 bindings omit it and default to 'd1'. */
  readonly engine?: 'd1' | 'mysql';
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlQueryResult<Record<string, any>[]>[]>;
}

/** Identity a persisted websocket connection ticket resolves to. */
export interface ConnectionTicketIdentity {
  userId: string;
  deviceIdentifier: string | null;
}

/**
 * Realtime notification push (Bitwarden clients connect over SignalR).
 *
 * On Cloudflare this is backed by the `NotificationsHub` Durable Object. On
 * platforms without singleton stateful workers the degraded implementation
 * signs/verifies short-lived tickets without storage and rejects websocket
 * upgrades; clients keep working through revision-date polling.
 */
export interface NotificationsHubPort {
  /**
   * Persist a short-lived signed connection ticket keyed to its identity so
   * the subsequent websocket upgrade can verify it was issued server-side.
   */
  registerConnectionTicket(
    input: ConnectionTicketIdentity & { token: string; expiresAt: number }
  ): Promise<void>;

  /**
   * Atomically consume a ticket. Returns the connected identity, or null when
   * the ticket is unknown, expired, or already consumed.
   */
  consumeConnectionTicket(
    token: string,
    routingUserId: string
  ): Promise<ConnectionTicketIdentity | null>;

  /**
   * Handle a websocket upgrade routed to the given identity. Returns the
   * websocket handshake response, or an error response when the platform
   * cannot hold long-lived connections.
   */
  connect(
    request: Request,
    identity: { userId: string; deviceIdentifier?: string } | { authRequestId: string }
  ): Promise<Response>;
}

/**
 * Stateful background runner for remote backup transfer jobs. Backed by the
 * `BackupTransferRunner` Durable Object on Cloudflare; degraded platforms
 * report `503` so callers surface a clear failure instead of hanging.
 */
export interface BackupRunnerPort {
  /**
   * Dispatch an internal request against the named runner object. Requests
   * use the internal `https://backup-transfer/internal/*` API; responses keep
   * the status/JSON contract callers already handle (404 / 409 / body error).
   */
  dispatch(runnerName: string, input: string, init?: RequestInit): Promise<Response>;
}
