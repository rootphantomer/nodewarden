import assert from 'node:assert/strict';
import test from 'node:test';

import { createInlineBackupRunner, getSqlDatabase } from '../src/platform';

/**
 * The inline backup runner (no-Durable-Objects fallback) must dispatch the
 * same `/internal/*` API the Cloudflare endpoint exposes, preserving status
 * codes callers already handle. Job-lease concurrency is exercised via a
 * scripted DB so the 409 path does not need a live MySQL server.
 */

const JWT = 'f7a2c1e89b04d53f6a7c8e91b2d4f5a6c3e7f0b1d2a4c6e8f9b0d1a2c3e4f5a6';

function fakeDb(overrides: Parameters<typeof getSqlDatabase>[0] extends never ? never : Record<string, unknown> = {}): unknown {
  void overrides;
  return {
    engine: 'd1',
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [], success: true, meta: {} }; },
        async run() { return { results: [], success: true, meta: { changes: 0 } }; },
      };
    },
    async batch() { return []; },
  };
}

function runInline(overrides?: Record<string, unknown>): {
  dispatch: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const env = {
    DB: fakeDb(),
    JWT_SECRET: JWT,
    ...(overrides || {}),
  } as unknown as import('../src/types').Env;
  const runner = createInlineBackupRunner(env);
  return {
    dispatch: (url, init) => runner.dispatch('configured-backup-runner', url, init),
  };
}

test('inline runner rejects non-POST and unknown endpoints like the DO', async () => {
  const inline = runInline();
  const getRequest = await inline.dispatch('https://backup-transfer/internal/run-scheduled-backups', { method: 'GET' });
  assert.equal(getRequest.status, 404);

  const unknown = await inline.dispatch('https://backup-transfer/internal/nothing-here', { method: 'POST' });
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Not found/);
});

test('attachment chunk upload reports missing blobs with 409', async () => {
  const inline = runInline();
  const response = await inline.dispatch('https://backup-transfer/internal/upload-attachment-chunk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      destination: {
        id: 'dest-1',
        type: 'webdav',
        destination: {
          baseUrl: 'https://backup.example.invalid/dav',
          username: 'svc',
          password: 'svc-password',
        },
        config: {},
      },
      attachments: [{ blobName: 'friendly/demo-file_name.bin' }],
    }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Attachment blob missing/);
});

test('configured backup run reports 409 while another lease is held', async () => {
  // Scripted lease: the acquire CAS upsert never lands (changes=0), which
  // readLease treats as "another run holds the row" -> 409 before any
  // business logic runs.
  const db = {
    engine: 'd1',
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [], success: true, meta: {} }; },
        async run() {
          return { results: [], success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch() { return []; },
  };
  const env = { DB: db, JWT_SECRET: JWT } as unknown as import('../src/types').Env;
  const runner = createInlineBackupRunner(env as never);

  const response = await runner.dispatch('configured-backup-runner', 'https://backup-transfer/internal/run-configured-backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorUserId: 'user-1', trigger: 'manual' }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /already in progress/);
});

test('manual configured backup run requires an actor', async () => {
  const inline = runInline();
  const response = await inline.dispatch('https://backup-transfer/internal/run-configured-backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: 'manual' }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /requires an actor/);
});
