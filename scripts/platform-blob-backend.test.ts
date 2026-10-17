import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteBlobObject,
  getBlobObject,
  getBlobStorageKind,
  putBlobObject,
} from '../src/services/blob-store';
import type { Env } from '../src/types';
import type { PlatformBlobBackend } from '../src/platform/types';

/**
 * The platform-neutral `ATTACHMENTS_BLOB` backend must behave exactly like
 * the Cloudflare R2/KV paths through the same blob-store facade: content
 * type defaults, read-back as a stream, and delete are all shared code.
 */

function envWithoutStorage(): Env {
  return { DB: null, JWT_SECRET: 'f7a2c1e89b04d53f6a7c8e91b2d4f5a6c3e7f0b1d2a4c6e8f9b0d1a2c3e4f5a6' } as unknown as Env;
}

test('no storage binding reports null kind and put fails with explicit error', async () => {
  const env = envWithoutStorage();
  assert.equal(getBlobStorageKind(env), null);
  await assert.rejects(
    () => putBlobObject(env, 'users/x/test.bin', new ArrayBuffer(4), { size: 4 }),
    /Attachment storage is not configured/
  );
  assert.equal(await getBlobObject(env, 'users/x/test.bin'), null);
});

test('platform blob backend stores bytes + content type and reads back', async () => {
  const stored = new Map<string, { data: ArrayBuffer; meta: { contentType?: string; customMetadata?: Record<string, string> | null } }>();
  const backend: PlatformBlobBackend = {
    async set(key, value, meta) {
      const data = value instanceof ArrayBuffer ? value : new TextEncoder().encode(value).buffer as ArrayBuffer;
      stored.set(key, { data, meta });
    },
    async getArrayBuffer(key) {
      return stored.get(key)?.data ?? null;
    },
    async getMetadataHeaders(key) {
      const entry = stored.get(key);
      if (!entry) return null;
      return { 'content-type': entry.meta.contentType || 'application/octet-stream' };
    },
    async delete(key) {
      stored.delete(key);
    },
  };
  const env = { ...envWithoutStorage(), ATTACHMENTS_BLOB: backend } as Env;
  assert.equal(getBlobStorageKind(env), 'blob');

  const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  await putBlobObject(env, 'users/x/att.bin', bytes, {
    size: 5,
    contentType: 'application/pdf',
    customMetadata: { fileName: 'att.bin' },
  });
  assert.ok(stored.has('users/x/att.bin'));

  const object = await getBlobObject(env, 'users/x/att.bin');
  assert.ok(object);
  assert.equal(object.contentType, 'application/pdf');
  assert.equal(object.size, 5);
  const readBack = new Uint8Array(await new Response(object.body).arrayBuffer());
  assert.deepEqual(Array.from(readBack), [1, 2, 3, 4, 5]);

  await deleteBlobObject(env, 'users/x/att.bin');
  assert.equal(stored.has('users/x/att.bin'), false);
  assert.equal(await getBlobObject(env, 'users/x/att.bin'), null);
});

test('R2 still takes precedence over the platform backend when both exist', async () => {
  const env = {
    ...envWithoutStorage(),
    ATTACHMENTS: {
      put: async () => { throw new Error('r2-used'); },
      get: async () => { throw new Error('r2-used'); },
    },
    ATTACHMENTS_BLOB: {
      set: async () => { throw new Error('blob-used'); },
    },
  } as unknown as Env;
  assert.equal(getBlobStorageKind(env), 'r2');
  const result = await getBlobObject(env, 'users/x/att.bin').catch((error: Error) => error.message);
  assert.equal(result, 'r2-used');
});
