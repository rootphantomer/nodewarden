import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPasswordVerifier,
  verifyPasswordVerifier,
  needsPasswordVerifierUpgrade,
} from '../src/services/password-verifier.ts';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function derive(clientHash: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(clientHash), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256
  );
  return toBase64(new Uint8Array(bits));
}

const CLIENT_HASH = 'client-side-master-password-hash';

test('current format round-trips', async () => {
  const stored = await createPasswordVerifier(CLIENT_HASH);
  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, stored, 'kou@example.com'), true);
  assert.equal(await verifyPasswordVerifier('wrong-hash', stored, 'kou@example.com'), false);
});

test("main2's $s$<salt>$<hash> rows still verify", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(CLIENT_HASH, salt);
  const stored = `$s$${toBase64(salt)}$${digest}`;

  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, stored, 'kou@example.com'), true);
  assert.equal(await verifyPasswordVerifier('wrong-hash', stored, 'kou@example.com'), false);
});

test("main2's rows are flagged for upgrade", () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  assert.equal(needsPasswordVerifierUpgrade(`$s$${toBase64(salt)}${'A'.repeat(44)}`), true);
});

test('pre-salt $s$<hash> legacy rows still verify via email-derived salt', async () => {
  const email = 'Kou@Example.com';
  const digest = await derive(CLIENT_HASH, new TextEncoder().encode(email.toLowerCase().trim()));
  const stored = `$s$${digest}`;

  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, stored, email), true);
  assert.equal(needsPasswordVerifierUpgrade(stored), true);
});

test('raw client hashes keep working', async () => {
  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, CLIENT_HASH, 'kou@example.com'), true);
  assert.equal(needsPasswordVerifierUpgrade(CLIENT_HASH), true);
});

test('missing and malformed rows never authenticate', async () => {
  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, null, 'kou@example.com'), false);
  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, '$s2$999999$bad$bad', 'kou@example.com'), false);
  assert.equal(await verifyPasswordVerifier(CLIENT_HASH, '$s$short$bad', 'kou@example.com'), false);
});

test('current-format rows are not flagged for upgrade', async () => {
  assert.equal(needsPasswordVerifierUpgrade(await createPasswordVerifier(CLIENT_HASH)), false);
});