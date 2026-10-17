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
    }
    return this.poolPromise;
  }
}

export function createMysqlDatabase(options: MysqlDatabaseOptions): MysqlDatabase {
  return new MysqlDatabase(options);
}
