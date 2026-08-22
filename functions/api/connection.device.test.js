// Device re-validation on the connection pre-flight.
// Run: node --test functions/api/connection.device.test.js
//
// The device lock is otherwise only checked at connect. Clearing a licence's hwid and
// rebinding to Machine B never touches Machine A's desktop_token, so Machine A would keep
// publishing indefinitely. These tests pin BOTH halves of the fix: that a moved licence is
// caught, AND that the check can never lock out someone it shouldn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './connection.js';
import { encryptToken } from './_crypto.js';

const OWNER = 'ig-owner-1';
const ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

function makeEnv({ licenseKey = 'lic_x', whopStatus = 201 } = {}) {
  const env = {
    TOKEN_ENC_KEY: ENC_KEY,
    API_SECRET: 'shared',
    WHOP_COMPANY_API: 'whop-key',
  };
  env.DB = {
    prepare(sql) {
      return {
        bind: () => ({
          async first() {
            if (sql.includes('desktop_token')) {
              return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
            }
            if (sql.includes('whop_license_key')) return { whop_license_key: licenseKey };
            if (sql.includes('access_token')) return env.__row;
            return null;
          },
        }),
      };
    },
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('validate_license')) {
      return new Response('{}', { status: whopStatus });
    }
    if (String(url).includes('api.whop.com')) {
      return new Response(JSON.stringify({ id: 'mem_x', valid: true, user: 'u' }), { status: 200 });
    }
    // Meta's publishing-limit probe
    return new Response(JSON.stringify({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] }), { status: 200 });
  };
  return env;
}

async function call(env, { deviceHash } = {}) {
  env.__row = { access_token: await encryptToken('IGAA-live', env), token_expiry: '2099-01-01T00:00:00Z' };
  const headers = { Authorization: 'Bearer tok' };
  if (deviceHash) headers['x-device-hash'] = deviceHash;
  const res = await onRequest({
    env,
    request: { method: 'GET', headers: { get: (h) => headers[h] ?? null } },
  });
  return { status: res.status, body: await res.json() };
}

test('a licence bound elsewhere reports device_moved, not publishable', async () => {
  const { body } = await call(makeEnv({ whopStatus: 400 }), { deviceHash: 'this-machine' });
  assert.equal(body.publishable, false);
  assert.equal(body.reason, 'device_moved');
});

test('the SAME machine passes through normally', async () => {
  const { body } = await call(makeEnv({ whopStatus: 201 }), { deviceHash: 'this-machine' });
  assert.equal(body.publishable, true);
});

// ── The four ways this check must NOT lock someone out ────────────────────────

test('an older build sending no device_hash still gets a working check', async () => {
  // Bricking installs over a header they cannot know about is worse than a later catch.
  // They are still gated at connect — /api/token hard-requires device_hash.
  const { body } = await call(makeEnv({ whopStatus: 400 }), {});
  assert.equal(body.publishable, true);
});

test('a pre-Whop row with no licence key is not locked out', async () => {
  // That column did not exist when they connected. Refusing them would be a regression
  // caused purely by a schema addition.
  const { body } = await call(makeEnv({ licenseKey: null, whopStatus: 400 }), { deviceHash: 'x' });
  assert.equal(body.publishable, true);
});

test('Whop being unreachable does not lock out a paying creator', async () => {
  // 502, not 409 — only a definitive "bound elsewhere" may block. This is a convenience
  // re-check; the authoritative gate is /api/token at connect.
  const { body } = await call(makeEnv({ whopStatus: 500 }), { deviceHash: 'x' });
  assert.equal(body.publishable, true);
});

test('a missing member:manage scope (401 from Whop) does not lock anyone out', async () => {
  const { body } = await call(makeEnv({ whopStatus: 401 }), { deviceHash: 'x' });
  assert.equal(body.publishable, true);
});
