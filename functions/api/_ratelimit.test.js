import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRateLimit, rateLimitStatus, clientKey } from './_ratelimit.js';

const stub = (results) => {
  const calls = [];
  return {
    calls,
    limit: async ({ key }) => {
      calls.push(key);
      return { success: results.shift() ?? true };
    },
  };
};

test('passes through while under the limit', async () => {
  const r = await requireRateLimit({ L: stub([true]) }, 'L', 'k');
  assert.equal(r, null);
});

test('returns 429 with Retry-After once over', async () => {
  const res = await requireRateLimit({ L: stub([false]) }, 'L', 'k');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal((await res.json()).error, 'Too many requests');
});

test('CORS headers survive onto the 429', async () => {
  const res = await requireRateLimit({ L: stub([false]) }, 'L', 'k', {
    'Access-Control-Allow-Origin': '*',
  });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

// ── The fail-open contract ────────────────────────────────────────────────────
// Pages Functions support for [[ratelimits]] is undocumented. If the binding is
// ignored, this must NOT take /api/token down — a limiter that causes a total
// outage is worse than the brute force it prevents.
test('missing binding fails OPEN, not with a 500', async () => {
  assert.equal(await requireRateLimit({}, 'MISSING', 'k'), null);
  assert.equal(await requireRateLimit({ MISSING: {} }, 'MISSING', 'k'), null);
  assert.equal(await requireRateLimit(undefined, 'MISSING', 'k'), null);
});

test('a throwing limiter fails OPEN too', async () => {
  const boom = { limit: async () => { throw new Error('binding exploded'); } };
  assert.equal(await requireRateLimit({ L: boom }, 'L', 'k'), null);
});

// ── Observability: absence must be checkable, never assumed ───────────────────
test('rateLimitStatus reports presence honestly', () => {
  assert.equal(rateLimitStatus({ L: stub([]) }, 'L').present, true);
  assert.equal(rateLimitStatus({}, 'L').present, false);
  assert.equal(rateLimitStatus({ L: {} }, 'L').present, false);
});

test('key is per-IP and a stripped header cannot opt out of the limit', () => {
  const withIp = new Request('https://x/', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  const without = new Request('https://x/');
  assert.equal(clientKey(withIp, 'token'), 'token:1.2.3.4');
  assert.equal(clientKey(without, 'token'), 'token:unknown');
  assert.notEqual(clientKey(without, 'token'), '');
});

test('distinct IPs get distinct buckets', async () => {
  const l = stub([true, true]);
  await requireRateLimit({ L: l }, 'L', 'token:1.1.1.1');
  await requireRateLimit({ L: l }, 'L', 'token:2.2.2.2');
  assert.deepEqual(l.calls, ['token:1.1.1.1', 'token:2.2.2.2']);
});
