// Tests for /api/media-upload/{key} — chunked (R2 multipart) upload for files over
// Cloudflare's 100 MB single-request limit.
// Run with: node --test functions/api/media-upload/upload.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { onRequest } from './[key].js';

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const IG_USER = '12345678901234567';
const TOKEN = 'desktop-token-abc';
const KEY = `${IG_USER}/reel/abc123.mp4`;
const MB = 1024 * 1024;


function makeEnv({ completeSize } = {}) {
  const state = { uploads: new Map(), objects: new Map(), deleted: [], aborted: [] };
  let n = 0;
  const bucket = {
    async createMultipartUpload(key, opts) {
      const uploadId = `up-${++n}`;
      state.uploads.set(uploadId, { key, opts, parts: new Map() });
      return handle(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return handle(key, uploadId);
    },
    async head(key) {
      return state.objects.has(key) ? { size: state.objects.get(key).size } : null;
    },
    async delete(key) {
      state.deleted.push(key);
      state.objects.delete(key);
    },
  };
  function handle(key, uploadId) {
    return {
      key,
      uploadId,
      async uploadPart(partNumber, body) {
        const u = state.uploads.get(uploadId);
        if (!u) throw new Error('no such upload');
        const bytes = new Uint8Array(body);
        u.parts.set(partNumber, bytes);
        return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
      },
      async complete(parts) {
        const u = state.uploads.get(uploadId);
        let size = 0;
        for (const p of parts) size += u.parts.get(p.partNumber).byteLength;
        state.objects.set(key, { size: completeSize ?? size });
        return { key, size: completeSize ?? size };
      },
      async abort() {
        state.aborted.push(uploadId);
        state.uploads.delete(uploadId);
      },
    };
  }
  const env = {
    API_SECRET: 'test-secret',
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('ig_tokens')) {
                  return { ig_user_id: IG_USER, desktop_token_created_at: new Date().toISOString() };
                }
                return null;
              },
            };
          },
        };
      },
    },
    SCHEDULE_BUCKET: bucket,
  };
  return { env, state };
}

function req({ method = 'POST', query = '', body, headers = {}, auth = `Bearer ${TOKEN}` }) {
  const h = new Map(Object.entries({ authorization: auth, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  const url = `https://brandgita.com/api/media-upload/${encodeURIComponent(KEY)}${query}`;
  let raw;
  if (body instanceof Uint8Array) raw = body;
  else if (body !== undefined) {
    raw = new TextEncoder().encode(JSON.stringify(body));
    h.set('content-type', 'application/json');
  }
  return {
    method,
    url,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    async json() {
      return JSON.parse(new TextDecoder().decode(raw));
    },
    async arrayBuffer() {
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    },
  };
}

const call = (env, request, key = KEY) => onRequest({ request, env, params: { key: encodeURIComponent(key) } });

async function create(env, over = {}) {
  const res = await call(env, req({ query: '?action=create', body: { content_type: 'video/mp4', size: 30 * MB, ...over } }));
  return { res, data: await res.json() };
}

test('create → returns an upload_id and the part size the client must use', async () => {
  const { env } = makeEnv();
  const { res, data } = await create(env);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.upload_id);
  assert.ok(data.part_size >= 5 * MB, 'R2 requires non-final parts of at least 5 MiB');
});

test('create without auth → 401', async () => {
  const { env } = makeEnv();
  const res = await call(env, req({ query: '?action=create', body: { content_type: 'video/mp4', size: 1 }, auth: '' }));
  assert.equal(res.status, 401);
});

test('create under someone else’s prefix → 403', async () => {
  const { env } = makeEnv();
  const other = '99999999999999999/reel/abc.mp4';
  const res = await call(env, req({ query: '?action=create', body: { content_type: 'video/mp4', size: 1 } }), other);
  assert.equal(res.status, 403);
});

test('create with an invalid key shape → 400', async () => {
  const { env } = makeEnv();
  const res = await call(env, req({ query: '?action=create', body: { content_type: 'video/mp4', size: 1 } }), `${IG_USER}/../etc/passwd`);
  assert.equal(res.status, 400);
});

test('create with a disallowed content type → 415', async () => {
  const { env } = makeEnv();
  const { res } = await create(env, { content_type: 'text/html' });
  assert.equal(res.status, 415);
});

test('create over the 600 MB ceiling → 413, nothing started in R2', async () => {
  const { env, state } = makeEnv();
  const { res } = await create(env, { size: 601 * MB });
  assert.equal(res.status, 413);
  assert.equal(state.uploads.size, 0);
});

test('create with a missing or non-positive size → 400', async () => {
  const { env } = makeEnv();
  assert.equal((await create(env, { size: 0 })).res.status, 400);
  assert.equal((await create(env, { size: 'big' })).res.status, 400);
});

test('part → stored, the R2 etag is returned for the client to verify', async () => {
  const { env, state } = makeEnv();
  const { data } = await create(env);
  const chunk = new Uint8Array(6 * MB).fill(7);
  const res = await call(env, req({
    method: 'PUT', query: `?upload_id=${data.upload_id}&part=1`, body: chunk,
  }));
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.part, 1);
  assert.ok(out.etag);
  assert.equal(state.uploads.get(data.upload_id).parts.get(1).byteLength, 6 * MB);
});

test('part number out of range → 400', async () => {
  const { env } = makeEnv();
  const { data } = await create(env);
  const chunk = new Uint8Array(1024);
  for (const part of ['0', '10001', 'abc']) {
    const res = await call(env, req({
      method: 'PUT', query: `?upload_id=${data.upload_id}&part=${part}`, body: chunk,
    }));
    assert.equal(res.status, 400, `part=${part}`);
  }
});

test('part larger than the declared part size → 413', async () => {
  const { env } = makeEnv();
  const { data } = await create(env);
  const chunk = new Uint8Array(data.part_size + 1);
  const res = await call(env, req({
    method: 'PUT', query: `?upload_id=${data.upload_id}&part=1`, body: chunk,
  }));
  assert.equal(res.status, 413);
});

test('complete with matching size → ok', async () => {
  const { env, state } = makeEnv();
  const { data } = await create(env, { size: 12 * MB });
  const parts = [];
  for (const n of [1, 2]) {
    const chunk = new Uint8Array(6 * MB).fill(n);
    const r = await (await call(env, req({
      method: 'PUT', query: `?upload_id=${data.upload_id}&part=${n}`, body: chunk,
    }))).json();
    parts.push({ part: n, etag: r.etag });
  }
  const res = await call(env, req({ query: '?action=complete', body: { upload_id: data.upload_id, size: 12 * MB, parts } }));
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.ok, true);
  assert.equal(out.key, KEY);
  assert.equal(state.objects.get(KEY).size, 12 * MB);
});

test('complete where the assembled size differs from the declared size → 422 and the object is DELETED', async () => {
  const { env, state } = makeEnv({ completeSize: 11 * MB });
  const { data } = await create(env, { size: 12 * MB });
  const chunk = new Uint8Array(6 * MB);
  const r = await (await call(env, req({
    method: 'PUT', query: `?upload_id=${data.upload_id}&part=1`, body: chunk,
  }))).json();
  const res = await call(env, req({ query: '?action=complete', body: { upload_id: data.upload_id, size: 12 * MB, parts: [{ part: 1, etag: r.etag }] } }));
  assert.equal(res.status, 422);
  assert.ok(state.deleted.includes(KEY), 'a wrong-sized object must never be left for Instagram to fetch');
  assert.equal(state.objects.has(KEY), false);
});

test('complete with no parts → 400', async () => {
  const { env } = makeEnv();
  const { data } = await create(env);
  const res = await call(env, req({ query: '?action=complete', body: { upload_id: data.upload_id, size: 1, parts: [] } }));
  assert.equal(res.status, 400);
});

test('abort → upload cancelled', async () => {
  const { env, state } = makeEnv();
  const { data } = await create(env);
  const res = await call(env, req({ method: 'DELETE', query: `?upload_id=${data.upload_id}` }));
  assert.equal(res.status, 200);
  assert.deepEqual(state.aborted, [data.upload_id]);
});

test('unknown action / method → 400 / 405', async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, req({ query: '?action=nope', body: {} }))).status, 400);
  assert.equal((await call(env, req({ method: 'GET' }))).status, 405);
});

test('a bug-report key can never be uploaded through this route', async () => {
  const { env } = makeEnv();
  const res = await call(env, req({ query: '?action=create', body: { content_type: 'video/mp4', size: 1 } }), 'bugreport/x/recording/a.webm');
  assert.equal(res.status, 400);
});
