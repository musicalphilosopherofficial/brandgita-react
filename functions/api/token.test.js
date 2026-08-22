// Tests for POST /api/token — run with:  node --test functions/api/token.test.js
// No deps: uses Node's built-in test runner. Mocks global fetch + a fake D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './token.js';

const ENV = {
  API_SECRET: 'test-secret',
  IG_CLIENT_ID: 'cid',
  IG_CLIENT_SECRET: 'csec',
  IG_REDIRECT_URI: 'https://brandgita.com/oauth/instagram',
  TOKEN_ENC_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', // base64 of 32 bytes — AES-256 key for encryptToken()
  WHOP_COMPANY_API: 'whop-test-key',
};

// Every test's IG code implies an active Whop membership by default — the OAuth
// flow's own tests are not testing licensing, so this keeps them from having to
// know about it. Tests of the license gate itself override with a specific handler.
function whopActiveMock(url) {
  const u = String(url);
  if (u.includes('validate_license')) {
    return { status: 201, ok: true, json: async () => ({}) };
  }
  if (u.includes('api.whop.com')) {
    return { ok: true, json: async () => ({ id: 'mem_test', status: 'active', user: { id: 'whopuser_test', email: 'c@example.com' } }) };
  }
  return null;
}

// Fake D1 that records the row it was asked to store.
function fakeDB() {
  const calls = [];
  return {
    calls,
    prepare() {
      return { bind: (...args) => { calls.push(args); return { run: async () => ({}) }; } };
    },
  };
}

function makeContext(body, { secret = 'test-secret', db = fakeDB() } = {}) {
  return {
    env: { ...ENV, DB: db },
    request: {
      method: 'POST',
      headers: { get: (k) => (k === 'x-api-secret' ? secret : null) },
      json: async () => ({ license_key: 'lic_test', device_hash: 'dev_test_hash', ...body }),
    },
  };
}

// Install a fetch mock that answers IG's two endpoints in sequence.
function mockFetch(handlers) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const whop = whopActiveMock(u);
    if (whop) return whop;
    for (const [match, resp] of handlers) {
      if (u.includes(match)) {
        return { ok: resp.ok ?? true, json: async () => resp.body };
      }
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

test('code path: exchanges code → short-lived → long-lived, returns ig_user_id', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const whop = whopActiveMock(url);
    if (whop) return whop;
    if (String(url).includes('api.instagram.com/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'short-tok', user_id: 178414 }) };
    }
    if (String(url).includes('graph.instagram.com/v22.0/me')) {
      // the /me call must now request BOTH username and profile_picture_url (the avatar fix)
      assert.ok(String(url).includes('profile_picture_url'), '/me must fetch profile_picture_url');
      return { ok: true, json: async () => ({ username: 'creator.handle', profile_picture_url: 'https://cdn.example/pic.jpg' }) };
    }
    if (String(url).includes('graph.instagram.com/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'long-tok', expires_in: 5184000 }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const db = fakeDB();
  const res = await onRequest(makeContext({ code: 'OAUTH_CODE' }, { db }));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.ig_user_id, '178414');           // derived from code exchange, returned to desktop
  assert.equal(data.username, 'creator.handle');      // fetched for display
  assert.equal(data.profile_picture_url, 'https://cdn.example/pic.jpg'); // avatar fix — returned to desktop
  assert.equal(data.expires_in_days, 60);
  const igCalls = seen.filter((u) => !u.includes('api.whop.com'));
  assert.ok(igCalls[0].includes('api.instagram.com/oauth/access_token')); // code → short first
  assert.ok(igCalls[1].includes('graph.instagram.com/access_token'));     // short → long second
  assert.equal(db.calls[0][0], '178414');             // stored under the derived user id
  assert.ok(db.calls[0][1].startsWith('v1:'));        // stored ENCRYPTED (AES-GCM), never the raw token
  assert.notEqual(db.calls[0][1], 'long-tok');        // plaintext must never hit D1
});

test('legacy path: {ig_user_id, short_lived_token} skips code exchange', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const whop = whopActiveMock(url);
    if (whop) return whop;
    if (String(url).includes('graph.instagram.com/v22.0/me')) {
      return { ok: true, json: async () => ({ username: 'legacy.handle' }) };
    }
    return { ok: true, json: async () => ({ access_token: 'long-tok', expires_in: 5184000 }) };
  };

  const res = await onRequest(makeContext({ ig_user_id: '999', short_lived_token: 'short-tok' }));
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(data.ig_user_id, '999');
  assert.ok(seen.some(u => u.includes('graph.instagram.com/access_token'))); // long-lived exchange ran
  assert.ok(!seen.some(u => u.includes('api.instagram.com/oauth/access_token'))); // no code exchange
});

test('missing both code and short_lived_token → 400', async () => {
  // The license check legitimately calls Whop first; IG must never be reached.
  globalThis.fetch = async (url) => {
    const whop = whopActiveMock(url);
    if (whop) return whop;
    throw new Error('should not fetch Instagram');
  };
  const res = await onRequest(makeContext({ ig_user_id: '999' })); // token missing
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
});

test('bad code exchange (no access_token) → 502, nothing stored', async () => {
  mockFetch([['api.instagram.com/oauth/access_token', { ok: false, body: { error_message: 'bad code' } }]]);
  const db = fakeDB();
  const res = await onRequest(makeContext({ code: 'BAD' }, { db }));
  const data = await res.json();
  assert.equal(res.status, 502);
  assert.equal(data.ok, false);
  assert.equal(data.error, 'OAuth code exchange failed'); // generic by design — never leak IG's raw error
  assert.equal(db.calls.length, 0);                                // never stored a token
});

test('wrong x-api-secret → 401', async () => {
  const res = await onRequest(makeContext({ code: 'X' }, { secret: 'wrong' }));
  assert.equal(res.status, 401);
});

// ── License gate ──────────────────────────────────────────────────────────────

test('a lapsed/invalid license_key blocks connect BEFORE the OAuth code is consumed', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('api.whop.com')) {
      return { ok: true, json: async () => ({ id: 'mem_x', status: 'canceled', user: { id: 'u' } }) };
    }
    throw new Error('IG must never be reached if the license is invalid');
  };
  const db = fakeDB();
  const res = await onRequest(makeContext({ code: 'OAUTH_CODE' }, { db }));
  const data = await res.json();

  assert.equal(res.status, 402);
  assert.equal(data.ok, false);
  assert.equal(db.calls.length, 0, 'nothing stored for a rejected license');
  assert.ok(!seen.some((u) => u.includes('instagram')), 'the single-use OAuth code must survive an invalid license');
});

test('a missing license_key is rejected with 400, not silently allowed', async () => {
  const res = await onRequest(
    makeContext({ code: 'X', license_key: undefined })
  );
  // makeContext defaults license_key unless explicitly overridden — construct the
  // request directly here to prove the endpoint itself enforces this, not the fixture.
  const ctx = {
    env: { ...ENV, DB: fakeDB() },
    request: {
      method: 'POST',
      headers: { get: (k) => (k === 'x-api-secret' ? 'test-secret' : null) },
      json: async () => ({ code: 'X' }), // no license_key at all
    },
  };
  const res2 = await onRequest(ctx);
  const data = await res2.json();
  assert.equal(res2.status, 400);
  assert.equal(data.ok, false);
});

test('the stored row links back to the Whop license + membership', async () => {
  mockFetch([
    ['api.instagram.com/oauth/access_token', { body: { access_token: 'short-tok', user_id: 1 } }],
    ['graph.instagram.com/access_token', { body: { access_token: 'long-tok', expires_in: 5184000 } }],
    ['graph.instagram.com/v22.0/me', { body: {} }],
  ]);
  const db = fakeDB();
  await onRequest(makeContext({ code: 'OAUTH_CODE', license_key: 'lic_specific' }, { db }));
  // INSERT OR REPLACE binds: ig_user_id, access_token, token_expiry, updated_at,
  // desktop_token, desktop_token_created_at, whop_license_key, whop_membership_id
  const [, , , , , , licenseKeyStored, membershipIdStored] = db.calls[0];
  assert.equal(licenseKeyStored, 'lic_specific');
  assert.equal(membershipIdStored, 'mem_test'); // from whopActiveMock
});

// ── Device lock ──────────────────────────────────────────────────────────────

test('a licence already bound to a DIFFERENT device is rejected with 409', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('validate_license')) return { status: 400, ok: false, json: async () => ({}) };
    if (u.includes('api.whop.com')) {
      return { ok: true, json: async () => ({ id: 'mem_test', status: 'active', user: { id: 'u' } }) };
    }
    throw new Error('IG must never be reached once the device check fails');
  };
  const db = fakeDB();
  const res = await onRequest(makeContext({ code: 'X' }, { db }));
  const data = await res.json();
  assert.equal(res.status, 409);
  assert.equal(data.ok, false);
  assert.equal(db.calls.length, 0);
});

test('missing device_hash is rejected with 400 — no silent skip of the lock', async () => {
  const ctx = {
    env: { ...ENV, DB: fakeDB() },
    request: {
      method: 'POST',
      headers: { get: (k) => (k === 'x-api-secret' ? 'test-secret' : null) },
      json: async () => ({ code: 'X', license_key: 'lic_test' }), // no device_hash
    },
  };
  const res = await onRequest(ctx);
  assert.equal(res.status, 400);
});

test('a 401 from validate_license (missing member:manage) fails closed, not open', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('validate_license')) return { status: 401, ok: false, json: async () => ({}) };
    if (u.includes('api.whop.com')) {
      return { ok: true, json: async () => ({ id: 'mem_test', status: 'active', user: { id: 'u' } }) };
    }
    throw new Error('IG must never be reached if the device check cannot be performed');
  };
  const db = fakeDB();
  const res = await onRequest(makeContext({ code: 'X' }, { db }));
  assert.equal(res.status, 502);
  assert.equal(db.calls.length, 0);
});
