// Tests for POST /api/reset-license — run with: node --test functions/api/reset-license.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './reset-license.js';

function fakeDB(rows = {}) {
  return {
    prepare(sql) {
      return {
        bind: (...args) => ({
          async first() { return sql.includes('SELECT') ? (rows[args[0]] ?? null) : null; },
          async run() { return {}; },
        }),
      };
    },
  };
}

const ENV = { API_SECRET: 'test-secret', WHOP_COMPANY_API: 'whop-key', DB: fakeDB() };

function ctx(body, { secret = 'test-secret', method = 'POST' } = {}) {
  return {
    env: ENV,
    request: {
      method,
      headers: { get: (k) => (k === 'x-api-secret' ? secret : null) },
      json: async () => body,
    },
  };
}

function membershipResponse(overrides = {}) {
  return { id: 'mem_x', status: 'active', valid: true, user: 'u', email: 'e@x.com', metadata: {}, ...overrides };
}

test('a valid reset succeeds end to end through the real route', async () => {
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(membershipResponse({ metadata: { hwid: 'old' } })), { status: 200 });
  };
  const res = await onRequest(ctx({ license_key: 'lic_x' }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('wrong x-api-secret is rejected before touching Whop at all', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  const res = await onRequest(ctx({ license_key: 'lic_x' }, { secret: 'wrong' }));
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('missing license_key is rejected with 400', async () => {
  const res = await onRequest(ctx({}));
  assert.equal(res.status, 400);
});

test('a cooldown rejection from resetDeviceLock passes through as 429', async () => {
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  globalThis.fetch = async () => new Response(JSON.stringify(membershipResponse()), { status: 200 });
  const cooldownEnv = { ...ENV, DB: fakeDB({ mem_x: { last_reset_at: recent } }) };
  const res = await onRequest({ ...ctx({ license_key: 'lic_x' }), env: cooldownEnv });
  const data = await res.json();
  assert.equal(res.status, 429);
  assert.match(data.error, /day/);
});

test('an invalid license passes through the friendly status-labelled error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(membershipResponse({ valid: false, status: 'expired' })), { status: 200 });
  const res = await onRequest(ctx({ license_key: 'lic_dead' }));
  const data = await res.json();
  assert.equal(res.status, 402);
  assert.match(data.error, /expired/);
});

test('GET is rejected', async () => {
  const res = await onRequest(ctx(null, { method: 'GET' }));
  assert.equal(res.status, 405);
});

test('OPTIONS returns CORS preflight', async () => {
  const res = await onRequest(ctx(null, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
});
