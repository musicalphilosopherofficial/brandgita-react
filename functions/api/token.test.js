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
};

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
      json: async () => body,
    },
  };
}

// Install a fetch mock that answers IG's two endpoints in sequence.
function mockFetch(handlers) {
  globalThis.fetch = async (url) => {
    const u = String(url);
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
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes('api.instagram.com/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'short-tok', user_id: 178414 }) };
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
  assert.equal(data.expires_in_days, 60);
  assert.ok(seen[0].includes('api.instagram.com/oauth/access_token')); // code → short first
  assert.ok(seen[1].includes('graph.instagram.com/access_token'));     // short → long second
  assert.equal(db.calls[0][0], '178414');             // stored under the derived user id
  assert.equal(db.calls[0][1], 'long-tok');           // stored the long-lived token
});

test('legacy path: {ig_user_id, short_lived_token} skips code exchange', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ access_token: 'long-tok', expires_in: 5184000 }) };
  };

  const res = await onRequest(makeContext({ ig_user_id: '999', short_lived_token: 'short-tok' }));
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(data.ig_user_id, '999');
  assert.equal(seen.length, 1);                                   // only the long-lived exchange
  assert.ok(seen[0].includes('graph.instagram.com/access_token'));
});

test('missing both code and short_lived_token → 400', async () => {
  globalThis.fetch = async () => { throw new Error('should not fetch'); };
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
  assert.equal(data.error, 'bad code');
  assert.equal(db.calls.length, 0);                                // never stored a token
});

test('wrong x-api-secret → 401', async () => {
  const res = await onRequest(makeContext({ code: 'X' }, { secret: 'wrong' }));
  assert.equal(res.status, 401);
});
