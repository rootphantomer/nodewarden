import { translateSqliteToMysql } from './translate-sqlite';

/**
 * Statement-level dispatch for the MySQL backend. Most statements pass
 * through the SQLite→MySQL translator; the handful of SQLite-only
 * statements (PRAGMA, sqlite_master) are rewritten to their MySQL
 * equivalents so the repository code keeps working unchanged.
 */

export type MysqlStatementTranslation =
  | { kind: 'pass'; sql: string }
  | { kind: 'noop' }
  | { kind: 'unsupported'; reason: string };

const WELL_KNOWN_DDL = new Map<string, string>([
  [
    normalizeWhitespace('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    'CREATE TABLE IF NOT EXISTS `config` (`key` VARCHAR(255) NOT NULL, `value` LONGTEXT NOT NULL, PRIMARY KEY (`key`))',
  ],
  [
    normalizeWhitespace('CREATE TABLE IF NOT EXISTS used_attachment_download_tokens (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)'),
    'CREATE TABLE IF NOT EXISTS `used_attachment_download_tokens` (`jti` VARCHAR(255) NOT NULL, `expires_at` BIGINT NOT NULL, PRIMARY KEY (`jti`))',
  ],
]);

function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/"/g, '\'').trim().toLowerCase();
}

const SQLITE_MASTER_IN_RE =
  /SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s*AND\s+name\s+IN/i;

const TABLE_INFO_RE =
  /^\s*PRAGMA\s+table_info\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)/i;

export function translateStatementForMysql(sql: string): MysqlStatementTranslation {
  if (/^\s*PRAGMA\s+foreign_keys/i.test(sql)) {
    // foreign keys are enforced per-connection by the pool init; nothing to do
    return { kind: 'noop' };
  }

  const tableInfo = TABLE_INFO_RE.exec(sql);
  if (tableInfo) {
    return {
      kind: 'pass',
      sql:
        `SELECT COLUMN_NAME AS name, UPPER(DATA_TYPE) AS type FROM INFORMATION_SCHEMA.COLUMNS ` +
        `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tableInfo[1]}' ORDER BY ORDINAL_POSITION`,
    };
  }

  if (SQLITE_MASTER_IN_RE.test(sql)) {
    return {
      kind: 'pass',
      sql: sql.replace(
        SQLITE_MASTER_IN_RE,
        'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN'
      ).replace(/type\s*=\s*'table'\s*AND\s+/i, ''),
    };
  }

  if (/SELECT\s+sql\s+FROM\s+sqlite_master/i.test(sql)) {
    return {
      kind: 'unsupported',
      reason:
        'sqlite_master DDL text is unavailable on MySQL; backup shadow-table restore requires the D1 engine',
    };
  }

  const wellKnown = WELL_KNOWN_DDL.get(normalizeWhitespace(sql));
  if (wellKnown) {
    return { kind: 'pass', sql: wellKnown };
  }

  return { kind: 'pass', sql: translateSqliteToMysql(sql) };
}
