// Tests for checkWhopLicense — run with: node --test functions/api/_whop.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWhopLicense } from './_whop.js';

function mockFetch(status, body) {
  return async () => new Response(JSON.stringify(body), { status });
}

test('an active membership is accepted and its identity extracted', async () => {
  globalThis.fetch = mockFetch(200, {
    id: 'mem_abc', status: 'active', user_id: 'user_1',
  });
  const r = await checkWhopLicense('lic_valid', { WHOP_COMPANY_API: 'k' });
  // v1 has no email field, so email is always null.
  assert.deepEqual(r, { ok: true, membershipId: 'mem_abc', whopUserId: 'user_1', email: null, metadata: {}, status: 'active' });
});

test('a 404 from Whop -> 402 "not found", not a raw pass-through', async () => {
  globalThis.fetch = mockFetch(404, { error: { message: 'No such Membership found' } });
  const r = await checkWhopLicense('lic_bad', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

test('a cancelled membership is rejected even though Whop found it', async () => {
  globalThis.fetch = mockFetch(200, { id: 'mem_x', status: 'canceled', user_id: 'u' });
  const r = await checkWhopLicense('lic_cancelled', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

test('REGRESSION: status="completed" is ACCEPTED — a real free-trial membership on this '
  + 'account reported exactly this status (v2 also said valid:true), so it must stay entitled', async () => {
  // Status captured from a real v2 response 2026-08-22 (membership mem_oBHeJeRZNqmKUl).
  // v1 has no `valid`, so the status allow-list is the gate; `completed` must be in it.
  globalThis.fetch = mockFetch(200, {
    id: 'mem_oBHeJeRZNqmKUl', status: 'completed', user_id: 'user_mvI3tlVgBiCNU',
  });
  const r = await checkWhopLicense('B-1D6B09-5C997A94-F155F5W', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, true);
  assert.equal(r.membershipId, 'mem_oBHeJeRZNqmKUl');
});

test('missing license_key is rejected before any network call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  const r = await checkWhopLicense('', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('missing WHOP_COMPANY_API fails closed with 503, never treated as "valid"', async () => {
  const r = await checkWhopLicense('lic_x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('a network failure fails CLOSED — unreachable Whop must not grant access', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r = await checkWhopLicense('lic_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('a malformed 200 (no user_id field at all) is rejected rather than trusted', async () => {
  globalThis.fetch = mockFetch(200, { id: 'mem_x', status: 'active' });
  const r = await checkWhopLicense('lic_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('the license key is URL-encoded into the request path', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ id: 'm', status: 'active', user_id: 'u' }), { status: 200 });
  };
  await checkWhopLicense('lic/with spaces', { WHOP_COMPANY_API: 'k' });
  assert.ok(!capturedUrl.includes('lic/with spaces'));
  assert.ok(capturedUrl.includes(encodeURIComponent('lic/with spaces')));
});

test('v1 migration: GET hits /api/v1 with Bearer auth and the Api-Version-Date pin', async () => {
  let url, headers;
  globalThis.fetch = async (u, opts) => {
    url = String(u); headers = opts.headers;
    return new Response(JSON.stringify({ id: 'm', status: 'active', user_id: 'u' }), { status: 200 });
  };
  await checkWhopLicense('lic_x', { WHOP_COMPANY_API: 'k' });
  assert.ok(url.startsWith('https://api.whop.com/api/v1/memberships/'));
  assert.equal(headers.Authorization, 'Bearer k');
  assert.match(headers['Api-Version-Date'], /^\d{4}-\d{2}-\d{2}/);
});

for (const st of ['trialing', 'active', 'completed']) {
  test(`status "${st}" is entitled`, async () => {
    globalThis.fetch = mockFetch(200, { id: 'm', status: st, user_id: 'u' });
    assert.equal((await checkWhopLicense('l', { WHOP_COMPANY_API: 'k' })).ok, true);
  });
}
for (const st of ['past_due', 'unresolved', 'canceled', 'expired', undefined]) {
  test(`status "${st}" is denied (fails closed)`, async () => {
    globalThis.fetch = mockFetch(200, { id: 'm', status: st, user_id: 'u' });
    const r = await checkWhopLicense('l', { WHOP_COMPANY_API: 'k' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 402);
  });
}

// ── validateDevice ────────────────────────────────────────────────────────────

import { validateDevice } from './_whop.js';

// v1 device lock: GET membership -> compare metadata.hwid -> PATCH on first use.
function deviceFetch({ metadata = {}, getStatus = 200, patchStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers, body: opts.body });
    if (opts.method === 'PATCH') return new Response('{}', { status: patchStatus });
    return new Response(JSON.stringify({ id: 'mem_x', status: 'active', user_id: 'u', metadata }), { status: getStatus });
  };
  return calls;
}

test('first use (no hwid stored) binds the device via PATCH and succeeds', async () => {
  const calls = deviceFetch();
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH']);
  assert.ok(calls.every((c) => c.url.startsWith('https://api.whop.com/api/v1/memberships/mem_x')));
  assert.ok(calls.every((c) => c.headers['Api-Version-Date']));
});

test('the SAME device again succeeds without writing anything', async () => {
  const calls = deviceFetch({ metadata: { hwid: 'hash123' } });
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('a licence bound to a DIFFERENT device is rejected with 409 and never overwritten', async () => {
  const calls = deviceFetch({ metadata: { hwid: 'other' } });
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('401/403 on the bind PATCH (missing member:manage) fails closed with 502', async () => {
  for (const patchStatus of [401, 403]) {
    deviceFetch({ patchStatus });
    const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
  }
});

test('403 on the membership lookup fails closed with 502', async () => {
  deviceFetch({ getStatus: 403 });
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('missing device_hash is rejected before any network call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 201 }); };
  const r = await validateDevice('mem_x', '', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('missing WHOP_COMPANY_API fails closed with 503', async () => {
  const r = await validateDevice('mem_x', 'hash', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('sends the metadata under Whop\'s own `hwid` key, not an invented one', async () => {
  // An earlier version used `device_hash`, and every call against a REAL, already-bound
  // membership came back as a mismatch because the key differed from what was stored.
  const calls = deviceFetch();
  await validateDevice('mem_x', 'the-hash', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'PATCH').body), { metadata: { hwid: 'the-hash' } });
});

test('a network failure fails closed', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  const r = await validateDevice('mem_x', 'hash', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

// ── resetDeviceLock ───────────────────────────────────────────────────────────

import { resetDeviceLock } from './_whop.js';

function membershipResponse(overrides = {}) {
  return {
    id: 'mem_x', status: 'active', user_id: 'u',
    metadata: {}, ...overrides,
  };
}

function fakeDB(rows = {}) {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      return {
        bind: (...args) => ({
          async first() {
            if (sql.includes('SELECT')) return rows[args[0]] ?? null;
            return null;
          },
          async run() {
            if (sql.includes('INSERT')) inserts.push(args);
            return {};
          },
        }),
      };
    },
  };
}

test('a first-ever reset (no cooldown row) succeeds and PATCHes an empty metadata wipe', async () => {
  let patchBody;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') { patchBody = JSON.parse(opts.body); return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(membershipResponse()), { status: 200 });
  };
  const db = fakeDB();
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: db });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(patchBody, { metadata: {} });
  assert.equal(db.inserts.length, 1, 'must stamp the cooldown after a successful reset');
});

test('a reset inside the 30-day cooldown is rejected with 429 and never touches Whop', async () => {
  const recentReset = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const db = fakeDB({ mem_x: { last_reset_at: recentReset } });
  let patchCalled = false;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') { patchCalled = true; return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(membershipResponse({ id: 'mem_x' })), { status: 200 });
  };
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: db });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.match(r.error, /\d+ day/);
  assert.equal(patchCalled, false, 'must not touch Whop once the cooldown rejects it');
});

test('a reset PAST the 30-day cooldown succeeds', async () => {
  const oldReset = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const db = fakeDB({ mem_x: { last_reset_at: oldReset } });
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(membershipResponse({ id: 'mem_x' })), { status: 200 });
  };
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: db });
  assert.equal(r.ok, true);
});

test('a DEAD subscription cannot consume a reset — rejected before touching D1 or Whop', async () => {
  let patchCalled = false;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') { patchCalled = true; return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(membershipResponse({ status: 'canceled' })), { status: 200 });
  };
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: fakeDB() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
  assert.match(r.error, /canceled/);
  assert.equal(patchCalled, false);
});

test('the PATCH body is always an unconditional empty wipe — never a merge attempt', async () => {
  let patchBody;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') { patchBody = JSON.parse(opts.body); return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(membershipResponse({ metadata: { hwid: 'whatever' } })), { status: 200 });
  };
  await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: fakeDB() });
  assert.deepEqual(patchBody, { metadata: {} });
});

test('the PATCH targets the v1 endpoint (v2 sunsets 2026-11-13)', async () => {
  let capturedUrl;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') { capturedUrl = url; return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify(membershipResponse()), { status: 200 });
  };
  await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: fakeDB() });
  assert.ok(String(capturedUrl).includes('/api/v1/memberships/'));
  assert.ok(!String(capturedUrl).includes('/api/v2/memberships/') || String(capturedUrl).includes('/api/v1/'));
});

test('a not-found license fails the same way checkWhopLicense already does', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  const r = await resetDeviceLock('lic_bad', { WHOP_COMPANY_API: 'k', DB: fakeDB() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

test('missing WHOP_COMPANY_API fails closed at the entitlement check', async () => {
  const r = await resetDeviceLock('lic_x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('missing DB binding fails closed rather than skipping the cooldown', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(membershipResponse()), { status: 200 });
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k' }); // no DB
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('a PATCH failure is reported and the cooldown is NOT stamped for a reset that never happened', async () => {
  const db = fakeDB();
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(membershipResponse()), { status: 200 });
  };
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: db });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.equal(db.inserts.length, 0, 'must not start a cooldown timer for a reset that failed');
});

test('a D1 cooldown-write failure does not undo an already-successful Whop reset', async () => {
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'PATCH') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(membershipResponse()), { status: 200 });
  };
  const db = fakeDB();
  db.prepare = (sql) => ({
    bind: () => ({
      async first() { return null; },
      async run() { throw new Error('D1 write failed'); },
    }),
  });
  const r = await resetDeviceLock('lic_x', { WHOP_COMPANY_API: 'k', DB: db });
  assert.equal(r.ok, true, 'the reset already happened on Whop — must not report failure');
});
