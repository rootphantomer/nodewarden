import assert from 'node:assert/strict';
import test from 'node:test';

import { handleEdgeOneRequest, type EdgeOneFunctionContext } from '../src/main-edgeone';
import type { Env, SqlDatabase, SqlStatement } from '../src/platform';

/**
 * End-to-end smoke of the EdgeOne entry without a live MySQL server:
 * - env assembly comes from context.env (MYSQL_URI / JWT_SECRET),
 * - the injected test DB satisfies the full SpaceService init flow,
 * - requests route through the real router.
 */

// 64+ hex chars: must pass the server's secret-strength validation.
const SECRET =
  'f7a2c1e89b04d53f6a7c8e91b2d4f5a6c3e7f0b1d2a4c6e8f9b0d1a2c3e4f5a6';

function permissiveDb(): SqlDatabase {
  const statement: SqlStatement = {
    bind() {
      return statement;
    },
    async first<T>(): Promise<T | null> {
      return null;
    },
    async all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
      return { results: [], success: true, meta: {} };
    },
    async run(): Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }> {
      return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } };
    },
  };
  return {
    engine: 'd1',
    prepare() {
      return statement;
    },
    async batch(statements) {
      return statements.map(() => ({ results: [], success: true, meta: { changes: 0 } }));
    },
  } as unknown as SqlDatabase;
}

function contextWithEnv(env: Record<string, unknown>, path = '/api'): EdgeOneFunctionContext {
  return {
    request: new Request(`https://nw.example.test${path}`),
    env,
    params: {},
  };
}

test('edgeone entry returns 503 configuration error without required vars', async () => {
  const response = await handleEdgeOneRequest({
    request: new Request('https://nw.example.test/api/config'),
    params: {},
  });
  assert.equal(response.status, 503);
});

test('missing JWT_SECRET alone reports configuration error', async () => {
  const response = await handleEdgeOneRequest(contextWithEnv({ MYSQL_URI: 'mysql://u:p@127.0.0.1/nw' }));
  assert.equal(response.status, 503);
});

test('non-backend path gets the uniform not-found response', async () => {
  const response = await handleEdgeOneRequest({
    request: new Request('https://nw.example.test/favicon.ico'),
    params: {},
    env: {
      MYSQL_URI: 'mysql://u:p@127.0.0.1/nw',
      JWT_SECRET: SECRET,
    },
  }, { DB: permissiveDb() });
  assert.equal(response.status, 404);
});

test('authenticated routing reaches the router (unauthorized profile -> 401)', async () => {
  const response = await handleEdgeOneRequest({
    request: new Request('https://nw.example.test/api/accounts/profile'),
    params: {},
    env: { MYSQL_URI: 'mysql://u:p@127.0.0.1/nw', JWT_SECRET: SECRET },
  }, { DB: permissiveDb() });
  assert.equal(response.status, 401);
});

test('expired-session auth flow produces 401 with error model body', async () => {
  const fakeJwt = 'invalid.token.value';
  const response = await handleEdgeOneRequest({
    request: new Request('https://nw.example.test/api/accounts/profile', {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    }),
    params: {},
    env: { MYSQL_URI: 'mysql://u:p@127.0.0.1/nw', JWT_SECRET: SECRET },
  }, { DB: permissiveDb() });
  assert.equal(response.status, 401);
  const body = await response.json() as { ErrorModel?: { Message?: string } };
  assert.ok(body.ErrorModel?.Message);
});
