// Tests for GET /api/fonts/* — the authenticated font-mirror read path.
// Run with: node --test functions/api/fonts/path.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { onRequest } from './[[path]].js';

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const LICENSE = 'lic_valid_123';

function makeEnv({ objects = {}, whopOk = true, whopStatus = 402 } = {}) {
  const bucketGetCalls = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () =>
      whopOk
        ? { id: 'mem_1', user: 'user_1', email: 'a@b.com', valid: true, status: 'active' }
        : { valid: false, status: 'canceled' },
  });
  return {
    WHOP_COMPANY_API: 'test-whop-key',
    FONTS_BUCKET: {
      async get(key) {
        bucketGetCalls.push(key);
        if (!(key in objects)) return null;
        return { body: objects[key] };
      },
    },
    __bucketGetCalls: bucketGetCalls,
  };
}

function ctx(env, { path, auth = `Bearer ${LICENSE}`, method = 'GET' } = {}) {
  return {
    env,
    params: { path },
    request: {
      method,
      headers: { get: (k) => (k === 'Authorization' ? auth : null) },
    },
  };
}

test('missing bearer licence → 401, never touches R2', async () => {
  const env = makeEnv();
  const res = await onRequest(ctx(env, { path: ['manifest.json'], auth: '' }));
  assert.equal(res.status, 401);
  assert.equal(env.__bucketGetCalls.length, 0);
});

test('invalid/lapsed licence → the licence check status, never touches R2', async () => {
  const env = makeEnv({ whopOk: false });
  const res = await onRequest(ctx(env, { path: ['manifest.json'] }));
  const data = await res.json();
  assert.equal(res.status, 402);
  assert.equal(data.ok, false);
  assert.equal(env.__bucketGetCalls.length, 0);
});

test('valid licence + manifest.json → 200 with application/json', async () => {
  const env = makeEnv({ objects: { 'manifest.json': '{"families":{}}' } });
  const res = await onRequest(ctx(env, { path: ['manifest.json'] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(await res.text(), '{"families":{}}');
});

test('valid licence + a real family weight → 200 with font/ttf', async () => {
  const env = makeEnv({ objects: { 'families/Archivo/400.ttf': 'fake-ttf-bytes' } });
  const res = await onRequest(ctx(env, { path: ['families', 'Archivo', '400.ttf'] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'font/ttf');
});

test('valid licence + a family LICENSE.txt → 200 with text/plain', async () => {
  const env = makeEnv({ objects: { 'families/Archivo/LICENSE.txt': 'OFL-1.1...' } });
  const res = await onRequest(ctx(env, { path: ['families', 'Archivo', 'LICENSE.txt'] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/plain; charset=utf-8');
});

test('an italic weight key is accepted by the shape check', async () => {
  const env = makeEnv({ objects: { 'families/Archivo/400i.ttf': 'bytes' } });
  const res = await onRequest(ctx(env, { path: ['families', 'Archivo', '400i.ttf'] }));
  assert.equal(res.status, 200);
});

test('a key matching the shape but absent from the bucket → 404, not 500', async () => {
  const env = makeEnv({ objects: {} });
  const res = await onRequest(ctx(env, { path: ['families', 'Archivo', '400.ttf'] }));
  assert.equal(res.status, 404);
  assert.equal(env.__bucketGetCalls.length, 1, 'a well-shaped key is still looked up');
});

test('path traversal is rejected before any R2 read', async () => {
  const env = makeEnv({ objects: { 'families/Archivo/400.ttf': 'bytes' } });
  const res = await onRequest(ctx(env, { path: ['families', '..', '..', 'wrangler.toml'] }));
  assert.equal(res.status, 404);
  assert.equal(env.__bucketGetCalls.length, 0);
});

test('a non-matching key shape is rejected before any R2 read', async () => {
  const env = makeEnv({ objects: { 'secrets.env': 'AWS_KEY=xyz' } });
  const res = await onRequest(ctx(env, { path: ['secrets.env'] }));
  assert.equal(res.status, 404);
  assert.equal(env.__bucketGetCalls.length, 0);
});

test('a woff2/otf extension is rejected — the mirror only ever uploads static .ttf', async () => {
  const env = makeEnv({ objects: { 'families/Archivo/400.woff2': 'bytes' } });
  const res = await onRequest(ctx(env, { path: ['families', 'Archivo', '400.woff2'] }));
  assert.equal(res.status, 404);
});

test('malformed percent-encoding in a path segment → 400, not a crash', async () => {
  const env = makeEnv();
  const res = await onRequest(ctx(env, { path: ['families', '%ZZ', '400.ttf'] }));
  assert.equal(res.status, 400);
});

test('non-GET → 405', async () => {
  const env = makeEnv();
  const res = await onRequest(ctx(env, { path: ['manifest.json'], method: 'POST' }));
  assert.equal(res.status, 405);
});

test('OPTIONS → 204, no auth required', async () => {
  const env = makeEnv();
  const res = await onRequest(ctx(env, { path: ['manifest.json'], auth: '', method: 'OPTIONS' }));
  assert.equal(res.status, 204);
});

test('a 200 response is never cacheable by a shared cache (authenticated bytes)', async () => {
  const env = makeEnv({ objects: { 'manifest.json': '{}' } });
  const res = await onRequest(ctx(env, { path: ['manifest.json'] }));
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});

test('no Access-Control-Allow-Origin on any response — this route is desktop-only, not browser-fetched', async () => {
  const env = makeEnv({ objects: { 'manifest.json': '{}' } });
  const res = await onRequest(ctx(env, { path: ['manifest.json'] }));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});
