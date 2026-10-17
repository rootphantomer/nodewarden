import assert from 'node:assert/strict';
import test from 'node:test';

import { translateSqliteToMysql, translateUpsert } from '../src/platform/sql/translate-sqlite';
import { translateStatementForMysql } from '../src/platform/sql/mysql-statements';

/**
 * Fixtures are the real statements issued by the repository layer
 * (assembled from their string concatenations verbatim). The translated
 * output must keep the bind-parameter count constant — parameter order is
 * not touched by the translator.
 */

test('plain statements pass through untouched when portable', () => {
  const sqle = 'DELETE FROM refresh_tokens WHERE expires_at < ?';
  assert.equal(translateSqliteToMysql(sqle), sqle);
});

test('strftime-based epoch migration rewrites to UNIX_TIMESTAMP', () => {
  const input =
    "UPDATE refresh_tokens SET created_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE created_at IS NULL";
  const out = translateSqliteToMysql(input);
  assert.equal(out, 'UPDATE refresh_tokens SET created_at = CAST(UNIX_TIMESTAMP() AS UNSIGNED) * 1000 WHERE created_at IS NULL');
});

test('INSERT OR IGNORE becomes INSERT IGNORE', () => {
  assert.equal(
    translateSqliteToMysql("INSERT OR IGNORE INTO rate_limit_buckets(bucket_key, count, expires_at, updated_at) VALUES(?, 0, ?, ?)"),
    "INSERT IGNORE INTO rate_limit_buckets(bucket_key, count, expires_at, updated_at) VALUES(?, 0, ?, ?)"
  );
});

test('INSERT OR REPLACE becomes REPLACE INTO', () => {
  assert.equal(
    translateSqliteToMysql("INSERT OR REPLACE INTO ciphers (id, user_id) VALUES (?, ?)"),
    "REPLACE INTO ciphers (id, user_id) VALUES (?, ?)"
  );
});

test('unconditional upsert with plain assignments', () => {
  const out = translateUpsert(
    'INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  assert.match(out, /INSERT INTO config\(key, value\) VALUES\(\?, \?\) AS new ON DUPLICATE KEY UPDATE/);
  assert.match(out, /value = new\.value/);
  assert.doesNotMatch(out, /ON CONFLICT/);
  assert.doesNotMatch(out, /excluded\./);
});

test('conditional upsert folds WHERE into IF per assignment (folders)', () => {
  const input =
    "INSERT INTO folders(id, user_id, name, created_at, updated_at) VALUES(?, ?, ?, ?, ?) " +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at WHERE user_id=excluded.user_id';
  const out = translateUpsert(input);
  assert.match(out, /VALUES\(\?, \?, \?, \?, \?\) AS new ON DUPLICATE KEY UPDATE/);
  // MySQL aliased upserts require table-qualified references to the existing row
  assert.match(out, /folders\.name\s*=\s*IF\(folders\.user_id\s*=\s*new\.user_id,\s*new\.name,\s*folders\.name\)/);
  assert.match(out, /folders\.updated_at\s*=\s*IF\(folders\.user_id\s*=\s*new\.user_id,\s*new\.updated_at,\s*folders\.updated_at\)/);
  assert.doesNotMatch(out, / WHERE /);
});

test('conditional upsert keeps subquery in condition (attachments)', () => {
  const input =
    'INSERT INTO attachments(id, cipher_id, file_name, size, size_name, key) VALUES(?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET cipher_id=excluded.cipher_id, file_name=excluded.file_name, size=excluded.size, size_name=excluded.size_name, key=excluded.key ' +
    'WHERE EXISTS (' +
    'SELECT 1 FROM ciphers current_cipher INNER JOIN ciphers next_cipher ON next_cipher.id = excluded.cipher_id ' +
    'WHERE current_cipher.id = attachments.cipher_id AND current_cipher.user_id = next_cipher.user_id' +
    ')';
  const out = translateUpsert(input);
  assert.match(out, /AS new ON DUPLICATE KEY UPDATE/);
  // condition folded into each assignment, alias applied inside the subquery
  assert.match(out, /attachments\.cipher_id = IF\(EXISTS \(SELECT 1 FROM ciphers current_cipher INNER JOIN ciphers next_cipher ON next_cipher\.id = new\.cipher_id WHERE current_cipher\.id = attachments\.cipher_id AND current_cipher\.user_id = next_cipher\.user_id\), new\.cipher_id, attachments\.cipher_id\)/);
  assert.match(out, /attachments\.key = IF\(EXISTS/, 'key assignment also wrapped');
});

test('upsert with CASE expression and no WHERE (devices)', () => {
  const input =
    "INSERT INTO devices(user_id, device_identifier, name, type, session_stamp, encrypted_user_key, encrypted_public_key, encrypted_private_key, push_uuid, banned, banned_at, device_note, last_seen_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?) " +
    'ON CONFLICT(user_id, device_identifier) DO UPDATE SET name=excluded.name, type=excluded.type, ' +
    'session_stamp=CASE WHEN devices.session_stamp IS NULL OR devices.session_stamp = ? THEN excluded.session_stamp ELSE devices.session_stamp END, ' +
    'encrypted_user_key=COALESCE(excluded.encrypted_user_key, encrypted_user_key), ' +
    'push_uuid=COALESCE(push_uuid, excluded.push_uuid)';
  const out = translateUpsert(input);
  assert.match(out, /ON DUPLICATE KEY UPDATE devices\.name\s*=\s*new\.name,\s*devices\.type\s*=\s*new\.type,/);
  assert.match(out, /devices\.session_stamp\s*=\s*CASE WHEN devices\.session_stamp IS NULL OR devices\.session_stamp = \? THEN new\.session_stamp ELSE devices\.session_stamp END/);
  assert.match(out, /devices\.push_uuid\s*=\s*COALESCE\(devices\.push_uuid, new\.push_uuid\)/);
});

test('ON CONFLICT DO NOTHING becomes no-op self-assignment', () => {
  const input = 'INSERT INTO used_attachment_download_tokens(jti, expires_at) VALUES(?, ?) ON CONFLICT(jti) DO NOTHING';
  const out = translateUpsert(input);
  assert.match(
    out,
    /ON DUPLICATE KEY UPDATE used_attachment_download_tokens\.`jti` = used_attachment_download_tokens\.`jti`|ON DUPLICATE KEY UPDATE `jti` = new\.`jti`/
  );
});

test('counter upsert keeps self-increment (login_attempts_ip)', () => {
  const input =
    "INSERT INTO login_attempts_ip(ip, attempts, locked_until, updated_at) VALUES(?, 1, NULL, ?) " +
    'ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at';
  const out = translateUpsert(input);
  assert.match(out, /AS new ON DUPLICATE KEY UPDATE login_attempts_ip\.attempts = login_attempts_ip\.attempts \+ 1, login_attempts_ip\.updated_at = new\.updated_at/);
});

test('reserved identifiers in ordinary statements are quoted', () => {
  assert.equal(
    translateSqliteToMysql("SELECT value FROM config WHERE key = ?"),
    "SELECT `value` FROM config WHERE `key` = ?"
  );
  assert.equal(
    translateSqliteToMysql('UPDATE config SET value = ? WHERE key = ?'),
    'UPDATE config SET `value` = ? WHERE `key` = ?'
  );
});

test('ON DUPLICATE KEY UPDATE phrase is never quoted as an identifier', () => {
  const out = translateSqliteToMysql(
    'INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  assert.match(out, /ON DUPLICATE KEY UPDATE config\.`value` = new\.`value`/);
});

test('PRAGMA table_info is translated to INFORMATION_SCHEMA', () => {
  const out = translateStatementForMysql('PRAGMA table_info(ciphers)');
  assert.equal(out.kind, 'pass');
  if (out.kind === 'pass') {
    assert.match(out.sql, /FROM INFORMATION_SCHEMA\.COLUMNS/);
    assert.match(out.sql, /TABLE_NAME = 'ciphers'/);
  }
});

test('sqlite_master table-existence probe becomes INFORMATION_SCHEMA.TABLES', () => {
  const input = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)";
  const out = translateStatementForMysql(input);
  assert.equal(out.kind, 'pass');
  if (out.kind === 'pass') {
    assert.match(out.sql, /FROM INFORMATION_SCHEMA\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME IN \(\?, \?, \?\)/);
  }
});

test('job lease upsert keeps the CAS guard and parses CAST AS SIGNED', () => {
  // The database job lease (src/services/job-lease.ts) acquires via a single
  // CAS upsert whose guard compares the leading numeric prefix of the value.
  const input = 'INSERT INTO config(key, value) VALUES(?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = ? WHERE CAST(value AS INTEGER) < ?';
  const out = translateStatementForMysql(input);
  assert.equal(out.kind, 'pass');
  if (out.kind === 'pass') {
    assert.match(out.sql, /AS new ON DUPLICATE KEY UPDATE/);
    assert.match(out.sql, /CAST\(config\.`value` AS SIGNED\) < \?/);
    assert.doesNotMatch(out.sql, /AS INTEGER/);
    // Four question marks: VALUES(?, ?) + SET value = ? + guard < ?
    assert.equal((out.sql.match(/\?/g) || []).length, 4);
  }
});

test('job lease touch/release updates keep value equality guards', () => {
  const input = 'UPDATE config SET value = ? WHERE key = ? AND value = ?';
  const out = translateStatementForMysql(input);
  assert.equal(out.kind, 'pass');
  if (out.kind === 'pass') {
    assert.match(out.sql, /UPDATE config SET `value` = \? WHERE `key` = \? AND `value` = \?/);
  }
});


test('sqlite_master DDL-text query is reported unsupported', () => {
  const out = translateStatementForMysql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");
  assert.equal(out.kind, 'unsupported');
});

test('inline config DDL is mapped to MySQL-typed DDL', () => {
  const out = translateStatementForMysql('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  assert.equal(out.kind, 'pass');
  if (out.kind === 'pass') {
    assert.match(out.sql, /`key` VARCHAR\(255\) NOT NULL/);
    assert.match(out.sql, /`value` LONGTEXT NOT NULL/);
    assert.match(out.sql, /PRIMARY KEY \(`key`\)/);
  }
});

test('PRAGMA foreign_keys is a silent no-op', () => {
  assert.deepEqual(translateStatementForMysql('PRAGMA foreign_keys = ON'), { kind: 'noop' });
});
