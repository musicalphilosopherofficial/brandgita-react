// GET/HEAD/Range on /api/media/{key}. Instagram's fetcher validates a video_url with HEAD and
// Range requests; a host that 405s HEAD or ignores Range can make a valid file fail with an
// opaque container status ERROR. Run: node --test functions/api/media/get.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './[key].js';

const KEY = '12345678901234567/reel/abc123.mp4';
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);

function makeEnv() {
  const calls = [];
  const slice = (range) => {
    const off = range?.offset ?? 0;
    const len = range?.length ?? BYTES.length - off;
    return BYTES.slice(off, off + len);
  };
  return {
    calls,
    SCHEDULE_BUCKET: {
      async head(key) {
        calls.push(['head', key]);
        return key === KEY ? { size: BYTES.length, httpMetadata: { contentType: 'video/mp4' } } : null;
      },
      async get(key, opts) {
        calls.push(['get', key, opts]);
        if (key !== KEY) return null;
        return { size: BYTES.length, httpMetadata: { contentType: 'video/mp4' }, body: new Blob([slice(opts?.range)]).stream() };
      },
    },
  };
}
const call = (env, method, headers = {}) =>
  onRequest({ env, params: { key: encodeURIComponent(KEY) }, request: { method, headers: { get: (k) => headers[k.toLowerCase()] ?? null } } });
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

test('GET advertises byte-range support and the exact length', async () => {
  const res = await call(makeEnv(), 'GET');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Content-Length'), '1000');
  assert.equal((await bytesOf(res)).length, 1000);
});

test('HEAD returns the headers with no body (not 405)', async () => {
  const res = await call(makeEnv(), 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.equal(res.headers.get('Content-Length'), '1000');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal((await bytesOf(res)).length, 0);
});

test('HEAD on a missing key → 404', async () => {
  const env = makeEnv();
  const res = await onRequest({ env, params: { key: encodeURIComponent('12345678901234567/reel/nope.mp4') }, request: { method: 'HEAD', headers: { get: () => null } } });
  assert.equal(res.status, 404);
});

test('Range bytes=0-99 → 206 with exactly those bytes and Content-Range', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bytes=0-99' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 0-99/1000');
  assert.equal(res.headers.get('Content-Length'), '100');
  assert.deepEqual([...(await bytesOf(res))], [...BYTES.slice(0, 100)]);
});

test('open-ended Range bytes=900- → the tail', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bytes=900-' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 900-999/1000');
  assert.deepEqual([...(await bytesOf(res))], [...BYTES.slice(900)]);
});

test('suffix Range bytes=-50 → the last 50 bytes', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bytes=-50' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 950-999/1000');
  assert.deepEqual([...(await bytesOf(res))], [...BYTES.slice(950)]);
});

test('Range end past EOF is clamped', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bytes=990-5000' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 990-999/1000');
});

test('unsatisfiable Range → 416 with Content-Range */size', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bytes=5000-6000' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('Content-Range'), 'bytes */1000');
});

test('a malformed Range header is ignored and the full file is served', async () => {
  const res = await call(makeEnv(), 'GET', { range: 'bananas=1-2' });
  assert.equal(res.status, 200);
  assert.equal((await bytesOf(res)).length, 1000);
});

test('keeps the no-store, nosniff and sandbox headers on every media response', async () => {
  for (const [method, headers] of [['GET', {}], ['HEAD', {}], ['GET', { range: 'bytes=0-9' }]]) {
    const res = await call(makeEnv(), method, headers);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  }
});
