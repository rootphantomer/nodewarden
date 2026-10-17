import { type SqlDatabase, type SqlStatement } from '../platform';

export async function isRegistered(db: SqlDatabase): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind('registered').first<{ value: string }>();
  return row?.value === 'true';
}

export async function getConfigValue(db: SqlDatabase, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return typeof row?.value === 'string' ? row.value : null;
}

export async function setConfigValue(db: SqlDatabase, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

export async function setRegistered(db: SqlDatabase): Promise<void> {
  await db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('registered', 'true')
    .run();
}
