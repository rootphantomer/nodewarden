import { SqlDatabase, SqlQueryMeta, SqlQueryResult, SqlStatement } from './types';

/**
 * D1 already implements exactly the `SqlDatabase` subset used by the data
 * layer, so the binding methods are surfaced one-to-one (after a structural
 * cast). Statements returned to repositories are the original D1 instruction
 * objects — batch() needs them pre-bound, and workerd rejects anything else.
 */
export function getSqlDatabase(env: { DB?: unknown }): SqlDatabase | null {
  const db = env.DB as {
    prepare(sql: string): unknown;
    batch(statements: unknown[]): Promise<Array<{ results?: unknown[]; meta?: SqlQueryMeta }>>;
  } | null | undefined;
  if (!db) return null;

  const database: SqlDatabase = {
    engine: 'd1',
    prepare(sql: string): SqlStatement {
      // The D1 instruction object satisfies the SqlStatement shape by design
      // (bind/first/all/run); repositories may only use that subset.
      return db.prepare(sql) as unknown as SqlStatement;
    },
    async batch(statements) {
      const results = await db.batch(statements);
      return results.map((result) => ({
        results: (result.results as Record<string, any>[] | undefined) || [],
        success: true,
        meta: (result.meta as SqlQueryMeta) || {},
      }));
    },
  };
  return database;
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

export type { SqlQueryResult, SqlStatement };
