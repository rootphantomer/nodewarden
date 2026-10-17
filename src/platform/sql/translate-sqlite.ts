/**
 * SQLite → MySQL dialect translation for the subset of SQL the data layer
 * actually issues. Real statements are used as test fixtures in
 * scripts/sqlite-to-mysql-translation.test.ts.
 *
 * Supported rewrites:
 * - `INSERT ... ON CONFLICT(cols) DO UPDATE SET ... [WHERE cond]` →
 *   `INSERT ... VALUES (...) AS new ON DUPLICATE KEY UPDATE ...`; a conditional
 *   WHERE folds into every assignment via `IF(...)`, so conflicting rows that
 *   fail the guard keep their stored values (SQLite semantics).
 * - `ON CONFLICT ... DO NOTHING` → self-assignment no-op.
 * - `INSERT OR IGNORE INTO` → `INSERT IGNORE INTO`.
 * - `CAST(strftime('%s','now') AS INTEGER) * 1000` → `CAST(UNIX_TIMESTAMP() AS
 *   UNSIGNED) * 1000`.
 * - Reserved-word column names (`key`, `value`, ...) get backtick-quoted while
 *   MySQL grammar phrases (`ON DUPLICATE KEY UPDATE`, `PRIMARY KEY`, ...) are
 *   protected from being quoted.
 */

const RESERVED_COLUMN_WORDS = ['key', 'value', 'usage', 'position', 'type'];

/** Find `term` occurrences at parenthesis depth 0 (term: regex source). */
export function findTopLevelTerm(sql: string, term: string, from: number, to: number): number {
  const anchored = new RegExp(`^${term}\\b`, 'i');
  let depth = 0;
  for (let i = from; i < to; i++) {
    const ch = sql[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth !== 0) continue;
    if (anchored.test(sql.slice(i, i + 64))) return i;
  }
  return -1;
}

/** Index of the closing paren that ends the VALUES clause. */
export function findValuesClose(sql: string, valuesIndex: number): number {
  let depth = 0;
  let enteredClause = false;
  for (let i = valuesIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && sql[j] !== "'") {
        if (sql[j] === "'" && sql[j + 1] === "'") j++;
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '(') { depth++; enteredClause = true; }
    else if (ch === ')') {
      depth--;
      if (enteredClause && depth === 0) return i;
    }
  }
  return -1;
}

/** Split comma list respecting parens depth and single-quoted strings. */
export function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "'") {
      current += ch;
      i++;
      while (i < list.length) {
        if (list[i] === "'") {
          if (list[i + 1] === "'") { current += "''"; i += 2; continue; }
          current += "'";
          i++;
          break;
        }
        current += list[i];
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function applyRowAlias(sql: string, alias: string): string {
  return sql.replace(/\bexcluded\./g, `${alias}.`);
}

function translateReservedIdentifiers(sql: string): string {
  // protect grammar phrases so their keywords stay unquoted
  const protectedPhrases: string[] = [];
  let working = sql.replace(
    /ON\s+DUPLICATE\s+KEY\s+UPDATE|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\s+KEY/gi,
    (phrase) => {
      protectedPhrases.push(phrase);
      return `\u0000P${protectedPhrases.length - 1}\u0000`;
    }
  );

  working = working.replace(
    new RegExp(`(?<![\\w\\\`])(${RESERVED_COLUMN_WORDS.join('|')})(?![\\w\\\`])`, 'gi'),
    (_m, word) => `\`${String(word).toLowerCase()}\``
  );

  working = working.replace(/\u0000P(\d+)\u0000/g, (_m, idx) => protectedPhrases[Number(idx)]);
  return working;
}

/** Rewrite SQLite upsert suffixes to MySQL `ON DUPLICATE KEY UPDATE`. */
export function translateUpsert(sql: string): string {
  const onConflictIdx = findTopLevelTerm(sql, 'ON\\s+CONFLICT', 0, sql.length);
  if (onConflictIdx < 0) return sql;

  const parenOpen = sql.indexOf('(', onConflictIdx);
  if (sql.slice(onConflictIdx + ' ON CONFLICT'.length, parenOpen).trim() !== '') return sql;
  const parenClose = sql.indexOf(')', parenOpen);
  if (parenOpen < 0 || parenClose < 0) return sql;
  const target = sql.slice(parenOpen + 1, parenClose);
  const firstCol = (target.match(/([A-Za-z_][A-Za-z0-9_]*)/) || [null, target])[1] as string;

  const afterTarget = sql.slice(parenClose + 1);
  const isDoNothing = /^\s*DO\s+NOTHING/i.test(afterTarget);
  const isDoUpdate = /^\s*DO\s+UPDATE\s+SET/i.test(afterTarget);
  if (!isDoNothing && !isDoUpdate) return sql;

  const insertHead = sql.slice(0, onConflictIdx).trimEnd();
  const valuesIdx = findTopLevelTerm(insertHead, 'VALUES', 0, insertHead.length);
  if (valuesIdx < 0) return sql;
  const closeParen = findValuesClose(insertHead, valuesIdx);
  if (closeParen < 0) return sql;

  const alias = 'new';
  const headWithAlias = `${insertHead.slice(0, closeParen + 1)} AS ${alias}${insertHead.slice(closeParen + 1)}`;

  if (isDoNothing) {
    const noopAssign = `\`${firstCol}\` = \`${firstCol}\``;
    return applyRowAlias(`${headWithAlias} ON DUPLICATE KEY UPDATE ${noopAssign}`, alias);
  }

  const remainder = applyRowAlias(sql.slice(parenClose + 1), alias);
  const setMatch = remainder.match(/^\s*DO\s+UPDATE\s+SET/i);
  if (!setMatch) return sql;
  let assignmentsPart = remainder.slice(remainder.indexOf('SET', remainder.toLowerCase().indexOf('do update')) + 'SET'.length);

  const whereRel = findTopLevelTerm(assignmentsPart, 'WHERE', 0, assignmentsPart.length);
  let condition: string | null = null;
  if (whereRel >= 0) {
    condition = applyRowAlias(assignmentsPart.slice(whereRel + 'WHERE'.length), alias).trim();
    assignmentsPart = assignmentsPart.slice(0, whereRel);
  }

  const assignments = splitTopLevel(assignmentsPart).map((pair) => {
    const trimmed = pair.trim();
    if (!condition) return trimmed;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return trimmed;
    const lhs = trimmed.slice(0, eq).trim();
    const rhs = trimmed.slice(eq + 1).trim();
    return `${lhs} = IF(${condition}, ${rhs}, ${lhs})`;
  });

  return `${headWithAlias} ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`;
}

export function translateSqliteToMysql(sql: string): string {
  let out = sql;
  out = out.replace(
    /CAST\s*\(\s*strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)\s*AS\s+INTEGER\s*\)\s*\*\s*1000/gi,
    'CAST(UNIX_TIMESTAMP() AS UNSIGNED) * 1000'
  );
  out = out.replace(/strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)/gi, 'UNIX_TIMESTAMP()');
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  out = out.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  // CAST(... AS INTEGER): MySQL needs SIGNED/UNSIGNED; SIGNED parses the
  // same leading-integer prefix SQLite casts from mixed strings.
  out = out.replace(/CAST\s*\(([^()]*?)\s+AS\s+INTEGER\s*\)/gi, 'CAST($1 AS SIGNED)');
  out = translateUpsert(out);
  out = translateReservedIdentifiers(out);
  return out;
}
