import { SqlDatabase } from './types';

/** Resolve the engine tag of a `SqlDatabase`. D1 bindings omit it. */
export function getSqlEngine(db: SqlDatabase): 'd1' | 'mysql' {
  if (db.engine === 'mysql') return 'mysql';
  return 'd1';
}
