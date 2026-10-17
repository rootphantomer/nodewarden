import type { SqlDatabase, SqlQueryMeta, SqlQueryResult, SqlStatement } from '../types';
import { translateStatementForMysql, type MysqlStatementTranslation } from '../sql/mysql-statements';

/**
 * MySQL backend for `SqlDatabase`, backed by `mysql2/promise` (available in
 * the EdgeOne Makers / Node.js runtimes). The module is loaded dynamically so
 * the Cloudflare bundle never references a socket-based driver it cannot run.
 *
 * Translation behavior:
 * - Every statement goes through `translateStatementForMysql` (SQLite→MySQL
 *   rewrites plus PRAGMA/sqlite_master intercepts).
 * - `batch()` runs statements inside a real transaction, mirroring D1's
 *   atomic-batch semantics.
 */

export interface MysqlDatabaseOptions {
  /** mysql2 connection URI, e.g. mysql://user:pass@host:3306/nodewarden */
  connectionUri: string;
  /** Max pool connections. Defaults to 5. */
  poolLimit?: number;
}

// ---- mysql2 dynamic loading -------------------------------------------------

let mysqlModulePromise: Promise<any> | null = null;

function loadMysqlModule(): Promise<any> {
  if (!mysqlModulePromise) {
    const moduleName = 'mysql2/promise';
    // Deliberately dynamic: keeps the Cloudflare bundle free of MySQL drivers.
    mysqlModulePromise = import(/* @vite-ignore */ moduleName);
  }
  return mysqlModulePromise;
}

// ---- statement --------------------------------------------------------------

class MysqlStatement implements SqlStatement {
  constructor(
    private readonly database: MysqlDatabase,
    public readonly sql: string,
    public readonly params: readonly unknown[]
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new MysqlStatement(this.database, this.sql, [...this.params, ...values]);
  }

  async first<T>(colName?: string): Promise<T | null> {
    const result = await this.database.executeRows(this.sql, this.params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName === undefined) return row as T;
    return (row[colName] ?? null) as T;
  }

  async all<T>(): Promise<SqlQueryResult<T[]>> {
    const result = await this.database.executeRows(this.sql, this.params);
    return { results: result.rows as T[], success: true, meta: result.meta };
  }

  async run(): Promise<SqlQueryResult<Record<string, any>[]>> {
    const result = await this.database.executeRows(this.sql, this.params);
    return { results: [], success: true, meta: result.meta };
  }
}

// ---- database ---------------------------------------------------------------

type MysqlCreateIndexTranslation = Extract<
  MysqlStatementTranslation,
  { kind: 'create-index' }
>;

/**
 * MySQL cannot express `CREATE INDEX IF NOT EXISTS`; the statement probes
 * INFORMATION_SCHEMA.STATISTICS for the index and only creates it when
 * absent, keeping both the schema bootstrap and repository ensure calls
 * idempotent across restarts.
 */
class MysqlCreateIndexStatement implements SqlStatement {
  constructor(
    private readonly database: MysqlDatabase,
    private readonly translation: MysqlCreateIndexTranslation
  ) {}

  bind(...values: unknown[]): SqlStatement {
    if (values.length) {
      throw new Error('CREATE INDEX statements do not take bindings');
    }
    return this;
  }

  async first(): Promise<null> {
    return null;
  }

  async all<T>(): Promise<SqlQueryResult<T[]>> {
    await this.run();
    return { results: [], success: true, meta: { changes: 0 } };
  }

  async run(): Promise<SqlQueryResult<Record<string, any>[]>> {
    const pool = await this.database.getPool();
    const [existing] = await pool.query(
      'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
      [this.translation.tableName, this.translation.indexName]
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return { results: [], success: true, meta: { changes: 0 } };
    }
    const [outcome] = await pool.query(this.translation.sql);
    return {
      results: [],
      success: true,
      meta: { changes: (outcome as { affectedRows?: number }).affectedRows ?? 0 },
    };
  }
}

export class MysqlDatabase implements SqlDatabase {
  readonly engine = 'mysql' as const;

  private poolPromise: Promise<any> | null = null;

  constructor(private readonly options: MysqlDatabaseOptions) {}

  prepare(sql: string): SqlStatement {
    const translation = translateStatementForMysql(sql);
    if (translation.kind === 'unsupported') {
      throw new Error(translation.reason);
    }
    if (translation.kind === 'noop') {
      // Statements with no MySQL counterpart (e.g. PRAGMA foreign_keys): treat as success.
      return new MysqlStatement(this, '', []);
    }
    if (translation.kind === 'create-index') {
      return new MysqlCreateIndexStatement(this, translation as MysqlCreateIndexTranslation);
    }
    return new MysqlStatement(this, translation.sql, []);
  }

  async batch(statements: SqlStatement[]): Promise<SqlQueryResult<Record<string, any>[]>[]> {
    const mysqlStatements = statements.filter(
      (statement): statement is MysqlStatement => statement instanceof MysqlStatement
    );
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const results: SqlQueryResult<Record<string, any>[]>[] = [];
      try {
        for (const statement of mysqlStatements) {
          if (!statement.sql) {
            results.push({ results: [], success: true, meta: {} });
            continue;
          }
          const [outcome] = await connection.query(statement.sql, statement.params);
          results.push({
            results: [],
            success: true,
            meta: {
              changes: (outcome as { affectedRows?: number }).affectedRows ?? 0,
              last_row_id: (outcome as { insertId?: number }).insertId ?? 0,
            },
          });
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
      return results;
    } finally {
      connection.release();
    }
  }

  async executeRows(sql: string, params: readonly unknown[]): Promise<{ rows: Record<string, any>[]; meta: SqlQueryMeta }> {
    if (!sql) return { rows: [], meta: {} };
    const pool = await this.getPool();
    const [result] = await pool.query(sql, params as any[]);
    // mysql2 returns row arrays for SELECT, and an OkPacket for
    // INSERT/UPDATE/DELETE — project both onto the D1-style shape.
    if (Array.isArray(result)) {
      return { rows: result as Record<string, any>[], meta: {} };
    }
    const packet = result as { affectedRows?: number; insertId?: number };
    return {
      rows: [],
      meta: { changes: packet.affectedRows ?? 0, last_row_id: packet.insertId ?? 0 },
    };
  }

  /** Raw pool handle, for callers that need to run session-level SQL. */
  async getPool(): Promise<any> {
    if (!this.poolPromise) {
      // Pools are cached per connection URI at module level: platform bootstraps
      // (e.g. the EdgeOne entry) construct a fresh `MysqlDatabase` per request,
      // and mysql2 pools must be reused across them or connections would
      // multiply with every invocation.
      const cacheKey = `${this.options.connectionUri}|${this.options.poolLimit ?? 5}`;
      const cached = getPoolCache().get(cacheKey);
      if (cached) {
        this.poolPromise = cached;
        return this.poolPromise;
      }
      this.poolPromise = (async () => {
        const mysql = await loadMysqlModule();
        return mysql.createPool({
          uri: this.options.connectionUri,
          waitForConnections: true,
          connectionLimit: this.options.poolLimit ?? 5,
          charset: 'utf8mb4_0900_ai_ci',
          timezone: 'Z',
          decimalNumbers: true,
          namedPlaceholders: false,
        });
      })();
      getPoolCache().set(cacheKey, this.poolPromise);
    }
    return this.poolPromise;
  }
}

let poolCache: Map<string, Promise<any>> | null = null;
function getPoolCache(): Map<string, Promise<any>> {
  if (!poolCache) poolCache = new Map();
  return poolCache;
}

export function createMysqlDatabase(options: MysqlDatabaseOptions): MysqlDatabase {
  return new MysqlDatabase(options);
}
