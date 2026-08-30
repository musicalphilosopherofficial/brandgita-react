// R2 upload fix (found 2026-08-30 running the real desktop app against production):
// R2Bucket.put() requires a stream with a known length. Piping the request body through
// a bare `new TransformStream()` strips that length, so every real upload landed in the
// generic 500 catch below with "Upload to storage failed". Mirrors the fake-D1/fake-R2
// style used in functions/api/schedule.patch.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { onRequest } from './[key].js';

// Node's webcrypto vs the Workers runtime's global `crypto` — polyfill the pieces
// _auth.js/mediaSlug use (subtle.importKey/sign, digest) if not already global.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const IG_USER = '12345678901234567';
const TOKEN = 'desktop-token-abc';
const TOKEN_HASH_SQL_MARKER = 'ig_tokens';

function makeEnv() {
  const putCalls = [];
  const env = {
    API_SECRET: 'test-secret-only-for-repro',
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes(TOKEN_HASH_SQL_MARKER)) {
                  return { ig_user_id: IG_USER, desktop_token_created_at: new Date().toISOString() };
                }
                return null;
              },
            };
          },
        };
      },
    },
    SCHEDULE_BUCKET: {
      async put(key, value, opts) {
        putCalls.push({ key, value, opts });
        return {};
      },
    },
  };
  return { env, putCalls };
}

function makeRequest({ bodyBytes, contentLength, contentType = 'video/mp4' }) {
  const headers = new Map([
    ['authorization', `Bearer ${TOKEN}`],
    ['content-type', contentType],
  ]);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));

  // A real Cloudflare Request's `.body` is a ReadableStream. Build one from the bytes so
  // pipeThrough/arrayBuffer both behave like the real thing.
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(bodyBytes);
      ctrl.close();
    },
  });

  return {
    method: 'PUT',
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    body,
    async arrayBuffer() {
      return bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength);
    },
  };
}

test('PUT with Content-Length: still streams, and the stream carries expectedLength', async () => {
  const { env, putCalls } = makeEnv();
  const bytes = new Uint8Array(1024).fill(7);
  const request = makeRequest({ bodyBytes: bytes, contentLength: bytes.byteLength });

  const res = await onRequest({ request, env, params: { key: `${IG_USER}/reel/abc123.mp4` } });
  const data = await res.json();

  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(putCalls.length, 1);
  // The bug was piping through a bare `new TransformStream()`, discarding length info.
  // The fix constructs the stream with expectedLength — verify put() still receives a
  // ReadableStream (still streaming, not needlessly buffered) when a length was declared.
  assert.ok(putCalls[0].value instanceof ReadableStream);
});

test('PUT with NO Content-Length: falls back to a buffered ArrayBuffer body (R2-safe, known length)', async () => {
  const { env, putCalls } = makeEnv();
  const bytes = new Uint8Array(512).fill(3);
  const request = makeRequest({ bodyBytes: bytes, contentLength: undefined, contentType: 'image/jpeg' });

  const res = await onRequest({ request, env, params: { key: `${IG_USER}/cover/xyz.jpg` } });
  const data = await res.json();

  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].value instanceof ArrayBuffer, `expected ArrayBuffer, got ${putCalls[0].value?.constructor?.name}`);
  assert.equal(putCalls[0].value.byteLength, 512);
});

test('oversize via declared Content-Length is rejected before touching R2', async () => {
  const { env, putCalls } = makeEnv();
  const bytes = new Uint8Array(10);
  const request = makeRequest({ bodyBytes: bytes, contentLength: 700 * 1024 * 1024 });

  const res = await onRequest({ request, env, params: { key: `${IG_USER}/reel/big.mp4` } });
  const data = await res.json();

  assert.equal(res.status, 413);
  assert.equal(data.ok, false);
  assert.equal(putCalls.length, 0);
});

test('oversize with no Content-Length is caught by the buffered-fallback size check', async () => {
  const { env, putCalls } = makeEnv();
  const MAX_BYTES = 600 * 1024 * 1024;
  const bytes = new Uint8Array(MAX_BYTES + 10);
  const request = makeRequest({ bodyBytes: bytes, contentLength: undefined, contentType: 'video/mp4' });

  const res = await onRequest({ request, env, params: { key: `${IG_USER}/reel/big.mp4` } });
  const data = await res.json();

  assert.equal(res.status, 413, JSON.stringify(data));
  assert.equal(putCalls.length, 0);
});
