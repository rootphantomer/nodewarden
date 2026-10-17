import assert from 'node:assert/strict';
import test from 'node:test';

import { handleNotificationsHub, handleNotificationsNegotiate } from '../src/handlers/notifications';
import type { Env } from '../src/types';
import { createJWT } from '../src/utils/jwt';
import { verifyWebSocketConnectionToken } from '../src/utils/websocket-connection-token';

/**
 * Degraded-platform contract: without a NOTIFICATIONS_HUB binding the
 * platform layer must still issue + accept signed connection tickets, and
 * reject websocket upgrades with a well-defined status instead of crashing
 * on the missing namespace.
 */

const userId = 'u_' + 'a'.repeat(16);
const securityStamp = 'sstamp_' + 'b'.repeat(16);
const secret = 'degraded-platform-test-secret';

function createDegradedEnv(): Env {
  const userRow = {
    id: userId,
    email: 'user@example.test',
    name: 'Test User',
    data: JSON.stringify({security_stamp: securityStamp}),
    security_stamp: securityStamp,
    two_factor_enabled: 0,
    totp_enabled: 0,
    email_verified: true,
    verified_email: true,
    yubikey_enabled: 0,
    yubikey_id: null,
    yubikey_nfc: 0,
    api_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return userRow;
        },
      };
    },
  } as unknown as D1Database;

  return { DB: db, JWT_SECRET: secret } as unknown as Env;
}

async function validAccessToken(): Promise<string> {
  return createJWT({
    sub: userId,
    email: 'user@example.test',
    name: 'Test User',
    sstamp: securityStamp,
  }, secret);
}

test('degraded platform still issues signed connection tickets via negotiate', async () => {
  const env = createDegradedEnv();
  const accessToken = await validAccessToken();
  const response = await handleNotificationsNegotiate(new Request(
    'https://vault.example.test/notifications/hub/negotiate',
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
  ), env);

  assert.equal(response.status, 200);
  const body = await response.json() as { connectionToken: string; negotiateVersion: number };
  assert.equal(body.negotiateVersion, 1);
  const claims = await verifyWebSocketConnectionToken(body.connectionToken, secret);
  assert.ok(claims);
  assert.equal(claims!.userId, userId);
  assert.ok(claims!.expiresAt > Date.now());
  assert.ok(claims!.expiresAt <= Date.now() + 60_000);
});

test('degraded platform rejects websocket upgrades with 501', async () => {
  const env = createDegradedEnv();
  const token = await validAccessToken();
  const response = await handleNotificationsHub(new Request(
    'https://vault.example.test/notifications/hub',
    { headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' } }
  ), env);

  assert.equal(response.status, 501);
  const body = await response.json() as { error: string };
  assert.match(body.error, /Realtime push is unavailable/);
});

test('degraded platform still rejects forged or expired tickets', async () => {
  const env = createDegradedEnv();
  const forged = 'invented-payload.' + 'A'.repeat(43);
  const response = await handleNotificationsHub(new Request(
    `https://vault.example.test/notifications/hub?id=${encodeURIComponent(forged)}`,
    { headers: { Upgrade: 'websocket' } }
  ), env);

  assert.equal(response.status, 401);
});
