import { Env } from '../types';
import { SqlDatabase, SqlStatement } from './types';

/**
 * Cloudflare D1 already implements exactly the `SqlDatabase` subset used by
 * the data layer, so on Cloudflare the binding is used directly (after a
 * structural cast). When an alternative backend lands (MySQL / PostgreSQL /
 * EdgeOne), implement `SqlDatabase` next to it and insert it here — the
 * repositories stay unchanged because they only call the subset.
 */
export function getSqlDatabase(env: Env): SqlDatabase | null {
  const db = (env as { DB?: unknown }).DB;
  if (!db) return null;
  return db as unknown as SqlDatabase;
}

/**
 * Small guard that adapts a backend-provided statement object (which may
 * carry extra methods such as `raw()`) into the strict `SqlStatement` shape.
 */
export function asSqlStatement(value: unknown): SqlStatement {
  const statement = value as SqlStatement | undefined;
  if (!statement || typeof statement.bind !== 'function' || typeof statement.run !== 'function') {
    throw new Error('Value does not implement SqlStatement');
  }
  return statement;
}
