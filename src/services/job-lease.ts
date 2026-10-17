import { SqlDatabase } from '../platform/types';

/**
 * Job lease for long-running backup transfer jobs.
 *
 * - Cloudflare: the Durable Object keeps its lease in DO storage (strong,
 *   singleton). See durable/backup-transfer-runner.ts.
 * - Other platforms: a small `config`-row lease using a numeric-prefix
 *   compare. The row value is `<expiresAtMs>|<token>`; both SQLite and MySQL
 *   parse the leading integer in `CAST(value AS INTEGER|SIGNED) < ?`, which
 *   makes acquisition a single compare-and-set statement.
 */

export interface JobLease {
  /** Returns the lease token, or null when another run holds the lease. */
  acquire(reason: string): Promise<string | null>;
  /** Extends the lease when still held by `token`. */
  touch(token: string): Promise<void>;
  /** Releases the lease only when `token` still holds it. */
  release(token: string): Promise<void>;
}

export interface DatabaseJobLeaseOptions {
  /** Config-table key holding the lease row. */
  key?: string;
  /** Initial and refreshed lease duration. Default: 10 minutes. */
  leaseMs?: number;
  /** Minimum interval between heartbeat rewrites. Default: 30 seconds. */
  heartbeatMs?: number;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

interface LeaseRow {
  token: string;
  expiresAtMs: number;
}

function parseLeaseValue(rawValue: unknown): LeaseRow | null {
  const value = String(rawValue ?? '').trim();
  if (!value || value === '0' || value === 'null') return null;
  const separator = value.indexOf('|');
  if (separator <= 0) return null;
  const expiresAtMs = Number(value.slice(0, separator));
  const token = value.slice(separator + 1).trim();
  if (!Number.isFinite(expiresAtMs) || !token) return null;
  return { token, expiresAtMs };
}

export function createDatabaseJobLease(
  db: SqlDatabase,
  options: DatabaseJobLeaseOptions = {}
): JobLease {
  const key = options.key || 'backup_transfer.lease';
  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs || DEFAULT_HEARTBEAT_MS;
  let lastHeartbeatAt = 0;

  async function readLease(): Promise<LeaseRow | null> {
    const statement = db.prepare('SELECT value FROM config WHERE key = ?').bind(key);
    const row = await statement.first<{ value: string }>();
    return parseLeaseValue(row?.value);
  }

  async function writeLeaseValue(value: string): Promise<boolean> {
    const result = await db
      .prepare(
        'INSERT INTO config(key, value) VALUES(?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = ? WHERE CAST(value AS INTEGER) < ?'
      )
      .bind(value, key, value, Date.now())
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  return {
    async acquire(reason): Promise<string | null> {
      const nowMs = Date.now();
      const current = await readLease();
      if (current && current.expiresAtMs > nowMs) return null;
      const token = crypto.randomUUID();
      const acquired = await writeLeaseValue(`${nowMs + leaseMs}|${token}`);
      if (!acquired) return null;
      lastHeartbeatAt = nowMs;
      void reason;
      return token;
    },

    async touch(token): Promise<void> {
      const nowMs = Date.now();
      if (nowMs - lastHeartbeatAt < heartbeatMs) return;
      const current = await readLease();
      if (!current || current.token !== token || current.expiresAtMs <= nowMs) return;
      lastHeartbeatAt = nowMs;
      await db
        .prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?')
        .bind(`${nowMs + leaseMs}|${token}`, key, `${current.expiresAtMs}|${token}`)
        .run();
    },

    async release(token): Promise<void> {
      const current = await readLease();
      if (!current || current.token !== token) return;
      await db
        .prepare('UPDATE config SET value = ? WHERE key = ? AND value = ?')
        .bind('0|released', key, `${current.expiresAtMs}|${token}`)
        .run();
    },
  };
}
