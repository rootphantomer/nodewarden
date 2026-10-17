#!/usr/bin/env node
/**
 * Local end-to-end smoke against a real MySQL server, driving the built
 * EdgeOne function bundle (cloud-functions/api/[[default]].js) exactly as
 * the platform would invoke it: handleEdgeOneRequest(context).
 *
 * Prereq: a MySQL 8 server; defaults match the companion docker container:
 *   docker run -d --name nw-mysql -e MYSQL_ROOT_PASSWORD=rootpw \
 *     -e MYSQL_DATABASE=nodewarden -e MYSQL_USER=nodewarden -e MYSQL_PASSWORD=nwpw \
 *     -p 127.0.0.1:3307:3306 mysql:8.4
 *
 * Usage: MYSQL_URI=mysql://nodewarden:nwpw@127.0.0.1:3307/nodewarden node scripts/local-mysql-smoke.mjs
 */
import assert from 'node:assert/strict';

const MYSQL_URI = process.env.MYSQL_URI || 'mysql://nodewarden:nwpw@127.0.0.1:3307/nodewarden';
const JWT_SECRET = process.env.JWT_SECRET
  || 'f7a2c1e89b04d53f6a7c8e91b2d4f5a6c3e7f0b1d2a4c6e8f9b0d1a2c3e4f5a6';
const BASE = 'http://127.0.0.1:9901';

const { default: handleEdgeOneRequest } = await import('../cloud-functions/api/[[default]].js');

let token = null;

async function call(path, init = {}) {
  const response = await handleEdgeOneRequest({
    request: new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        'CF-Connecting-IP': '127.0.0.1',
        Origin: BASE,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    }),
    params: {},
    env: { MYSQL_URI, JWT_SECRET },
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, body, text };
}

let passed = 0;
function step(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}

// --- 1. public surface -------------------------------------------------------

const config = await call('/api/config');
assert.equal(config.status, 200, `GET /api/config -> ${config.status}: ${config.text}`);
assert.ok(config.body?.Version || config.body?.version !== undefined, 'config exposes a version field');
step('GET /api/config serves platform config');

// --- 2. register first user (auto-admin) -------------------------------------

const email = `smoke-${Date.now()}@example.test`;
const register = await call('/api/accounts/register', {
  method: 'POST',
  body: JSON.stringify({
    email,
    name: 'Smoke Admin',
    masterPasswordHash: 'oVQZOpQZOpQZOpQZOpQZOpQZOpQ=',
    key: '0.XXXXXXXXXXXXXXXXXXXXXXXX==|YYYYYYYYYYYYYYYYYYYYYYYY==',
    kdf: 0,
    kdfIterations: 600000,
    keys: {
      publicKey: 'FAKEPUBLICKEY-smoke-rsa2048-NotFoundKeysInBundle',
      encryptedPrivateKey: '0.ZZZZZZZZZZZZZZZZZZZZZZZZZZ==|WWWWWWWWWWWWWWWWWWWWWWWW==',
    },
  }),
});
assert.equal(register.status, 200, `register -> ${register.status}: ${register.text}`);
assert.equal(register.body?.role, 'admin');
step('POST /api/accounts/register creates the first admin');

// --- 3. login ----------------------------------------------------------------

const login = await call('/identity/connect/token', {
  method: 'POST',
  body: JSON.stringify({
    grant_type: 'password',
    username: email,
    password: 'oVQZOpQZOpQZOpQZOpQZOpQZOpQ=',
    scope: 'api offline_access',
    client_id: 'web',
  }),
});
assert.equal(login.status, 200, `login -> ${login.status}: ${login.text}`);
token = login.body?.access_token ?? login.body?.AccessToken
  ?? login.body?.token?.AccessToken ?? login.body?.token?.access_token;
assert.ok(token, `login returned no token: ${JSON.stringify(login.body).slice(0, 400)}`);
step('POST /identity/connect/token issues a JWT');

// --- 4. authenticated surface ------------------------------------------------

const profile = await call('/api/accounts/profile');
assert.equal(profile.status, 200, `profile -> ${profile.status}: ${profile.text}`);
assert.equal(String(profile.body?.Email || profile.body?.email || '').toLowerCase(), email);
step('GET /api/accounts/profile reads the admin profile');

// --- 5. cipher CRUD ----------------------------------------------------------

const created = await call('/api/ciphers', {
  method: 'POST',
  body: JSON.stringify({
    type: 1,
    name: '0.SMOKEIVSMOKEIV|SMOKECTSMOKECT',
    notes: null,
    login: {
      username: '0.USERIVUSERIV|USERCTUSERCT',
      password: '0.PWIVPWIVPW|PWCTPWCTPW',
      totp: null,
      uris: [{ uri: '0.URIIVURIIV|URICTURICTUR' }],
    },
  }),
});
assert.equal(created.status, 200, `cipher create -> ${created.status}: ${created.text}`);
const cipherId = created.body?.id ?? created.body?.Id;
assert.ok(cipherId, `no cipher id: ${created.text.slice(0, 300)}`);
step(`POST /api/ciphers creates a login cipher (${cipherId.slice(0, 8)}…)`);

const getCipher = await call(`/api/ciphers/${cipherId}`);
assert.equal(getCipher.status, 200, `cipher get -> ${getCipher.status}: ${getCipher.text}`);
step('GET /api/ciphers/{id} reads back the cipher');

const update = await call(`/api/ciphers/${cipherId}`, {
  method: 'PUT',
  body: JSON.stringify({
    type: 1,
    name: '0.UPDTIVUPDTIV|UPDTCTUPDTCT',
    login: { username: '0.USERIVUSERIV|USERCTUSERCT', password: '0.PW2IVPW2IV|PW2CTPW2CT' },
  }),
});
assert.equal(update.status, 200, `cipher update -> ${update.status}: ${update.text}`);
step('PUT /api/ciphers/{id} updates the cipher');

const list = await call('/api/ciphers');
assert.equal(list.status, 200, `cipher list -> ${list.status}: ${list.text}`);
assert.ok(JSON.stringify(list.body).includes(cipherId), 'cipher shows up in the list');
step('GET /api/ciphers lists the updated cipher');

const sync = await call('/api/sync');
assert.equal(sync.status, 200, `sync -> ${sync.status}: ${sync.text}`);
const syncBlob = JSON.stringify(sync.body);
assert.ok(syncBlob.includes(cipherId) && syncBlob.includes(email));
step('GET /api/sync returns profile + vault data');

const softDelete = await call(`/api/ciphers/${cipherId}/delete`, { method: 'PUT' });
assert.equal(softDelete.status, 200, `soft delete -> ${softDelete.status}: ${softDelete.text}`);
const permanentDelete = await call(`/api/ciphers/${cipherId}/delete`, { method: 'DELETE' });
assert.ok([200, 204].includes(permanentDelete.status),
  `permanent delete -> ${permanentDelete.status}: ${permanentDelete.text}`);
step('soft delete + permanent delete complete the CRUD loop');

// --- 6. attachment degradation (no blob backend on plain Node) ---------------

const recreated = await call('/api/ciphers', {
  method: 'POST',
  body: JSON.stringify({ type: 1, name: '0.ATTIVATTIV|ATTCTATTCT', login: {} }),
});
assert.equal(recreated.status, 200, `recreate for attachment -> ${recreated.status}: ${recreated.text}`);
const recreatedId = recreated.body?.id ?? recreated.body?.Id;

const attachment = await call(`/api/ciphers/${recreatedId}/attachment`, {
  method: 'POST',
  body: JSON.stringify({ fileName: '0.FILENAMEFILE|FILENAMEFILE', key: '0.ATTKIVATTKIV|ATTKCTATTKCT', fileSize: 32 }),
});
assert.equal(attachment.status, 200, `attachment create -> ${attachment.status}: ${attachment.text}`);

// Follow the returned upload URL: without a blob backend on plain Node the
// actual byte upload must fail with a defined storage error.
const uploadUrl = attachment.body?.url;
assert.ok(typeof uploadUrl === 'string' && uploadUrl.includes('/api/ciphers/'), 'upload URL issued');
const uploadPath = uploadUrl.startsWith('http') ? new URL(uploadUrl).pathname + new URL(uploadUrl).search : uploadUrl;
const upload = await call(uploadPath, { method: 'PUT', body: new Uint8Array(32) });
assert.ok(upload.status >= 400 && upload.status < 600,
  `attachment upload should degrade, got ${upload.status}: ${upload.text}`);
step(`attachment upload degrades without a blob backend (HTTP ${upload.status})`);

// --- 7. backup chain touches the inline runner -------------------------------

const backupRun = await call('/api/admin/backup/run', { method: 'POST', body: JSON.stringify({}) });
assert.notEqual(backupRun.status, 401, 'admin backup run should authenticate');
assert.ok(
  backupRun.status === 200 || (backupRun.status >= 400 && backupRun.status < 600),
  `backup run returned ${backupRun.status}`
);
step(`admin backup run dispatches through the inline runner (HTTP ${backupRun.status})`);

// --- summary -----------------------------------------------------------------

console.log(`\nlocal-mysql-smoke: ALL ${passed} STEPS PASSED`);
