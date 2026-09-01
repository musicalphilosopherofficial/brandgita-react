// Tests for POST /api/bugreport/media and GET /api/bugreport/media/{key}
// Run with: node --test functions/api/bugreport/media.test.js
//
// Layer: TDD unit. This is request handling — auth, tenancy, quota, size and type
// limits. The creator-facing journey (record, preview, attach, send) is the BDD
// scenario and lives in the Electron suite.
//
// The tests that matter most here are the NEGATIVE ones. This route exists only because
// the sibling GET /api/media/{key} is unauthenticated by design, so "the new route is
// actually authenticated" is not a detail — it is the entire justification for the
// route existing. A suite that only proved the happy path would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { onRequest as upload } from './media.js';
import { onRequest as fetchMedia } from './media/[key].js';
import { onRequest as publicMedia } from '../media/[key].js';
import { bugMediaSlug, isBugMediaKey, isCoherentMediaKey, MEDIA_KEY_SHAPE, MEDIA_KINDS } from './_media.js';

const MAX_RECORDING_BYTES = MEDIA_KINDS.recording.maxBytes;

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

const LICENCE = 'B-AAAA-BBBB-CCCC';
const OTHER_LICENCE = 'B-ZZZZ-YYYY-XXXX';
const SECRET = 'test-secret-only-for-repro';

const whopFor = (membershipId) => async (key) => {
  if (key === LICENCE) return { ok: true, membershipId: 'mem_123' };
  if (key === OTHER_LICENCE) return { ok: true, membershipId: 'mem_999' };
  return { ok: false, status: 403, error: 'Invalid licence' };
};

function makeEnv({ objects = [], listThrows = false, putThrows = false, store = new Map() } = {}) {
  return {
    API_SECRET: SECRET,
    __checkWhopLicense: whopFor(),
    SCHEDULE_BUCKET: {
      // Prefix-aware, so a per-kind quota test actually proves the prefix is per kind.
      // `objects` may be a flat array (same answer for every prefix) or a
      // {prefixSubstring: count} map.
      async list({ prefix } = {}) {
        if (listThrows) throw new Error('R2 down');
        if (Array.isArray(objects)) return { objects };
        for (const [needle, n] of Object.entries(objects || {})) {
          if (String(prefix).includes(needle)) return { objects: new Array(n).fill({ key: 'x' }) };
        }
        return { objects: [] };
      },
      async put(key, value, opts) {
        if (putThrows) throw new Error('R2 down');
        store.set(key, { body: value, httpMetadata: opts?.httpMetadata });
        return {};
      },
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
    },
    __store: store,
  };
}

function uploadReq({ licence = LICENCE, contentType = 'video/webm', bytes = new Uint8Array([1, 2, 3]), contentLength, method = 'POST', kind = 'recording' } = {}) {
  const headers = new Map();
  if (licence) headers.set('x-license-key', licence);
  if (contentType) headers.set('content-type', contentType);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return {
    method,
    url: `https://brandgita.com/api/bugreport/media?kind=${encodeURIComponent(kind)}`,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function getReq({ licence = LICENCE, method = 'GET' } = {}) {
  const headers = new Map();
  if (licence) headers.set('x-license-key', licence);
  return { method, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } };
}

const body = async (res) => JSON.parse(await res.text());

// ---------------------------------------------------------------------------
// upload — the happy path, and what a key is allowed to look like
// ---------------------------------------------------------------------------

test('a licensed upload is stored and returns an opaque key', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq(), env });
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.equal(j.ok, true);
  assert.match(j.media_key, MEDIA_KEY_SHAPE, 'key should match the pinned shape');
  assert.equal(j.bytes, 3);
  // No URL in the response. Handing back a link invites treating it as shareable, which
  // is exactly what this route exists to prevent.
  assert.equal(j.url, undefined);
  assert.ok(env.__store.has(j.media_key), 'the bytes should be in the bucket');
});

test('the minted key carries the membership slug, not the membership id', async () => {
  const env = makeEnv();
  const j = await body(await upload({ request: uploadReq(), env }));
  assert.ok(!j.media_key.includes('mem_123'), 'a raw membership id must never appear in a key');
  const slug = await bugMediaSlug(env, 'mem_123');
  assert.ok(j.media_key.startsWith(`bugreport/${slug}/`));
});

test('two different memberships get different slugs', async () => {
  const env = makeEnv();
  const a = await bugMediaSlug(env, 'mem_123');
  const b = await bugMediaSlug(env, 'mem_999');
  assert.notEqual(a, b);
});

test('the bug-media slug is unrelated to the public media slug for the same identity', async () => {
  // Otherwise publishing a creator's public reel URL would also publish the prefix their
  // private recordings live under.
  const { mediaSlug } = await import('../_auth.js');
  const env = makeEnv();
  assert.notEqual(await bugMediaSlug(env, 'mem_123'), await mediaSlug(env, 'mem_123'));
});

// ---------------------------------------------------------------------------
// upload — auth, and it fails closed
// ---------------------------------------------------------------------------

test('an upload with NO licence header is rejected with 401 and stores nothing', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ licence: null }), env });
  assert.equal(res.status, 401);
  assert.equal(env.__store.size, 0);
});

test('an upload with an INVALID licence is rejected and stores nothing', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ licence: 'B-NOPE' }), env });
  assert.equal(res.status, 403);
  assert.equal(env.__store.size, 0);
});

test('an upstream licence error rejects — it must not fail open', async () => {
  const env = makeEnv();
  env.__checkWhopLicense = async () => ({ ok: false, status: 502, error: 'upstream' });
  const res = await upload({ request: uploadReq(), env });
  assert.ok(res.status >= 400);
  assert.equal(env.__store.size, 0);
});

test('an unconfigured slug secret refuses rather than sharing one namespace', async () => {
  // Falling back to a constant prefix would put every creator's recordings under the
  // same slug, and the tenancy check on GET would then pass for all of them.
  const env = makeEnv();
  delete env.API_SECRET;
  const res = await upload({ request: uploadReq(), env });
  assert.equal(res.status, 503);
  assert.equal(env.__store.size, 0);
});

// ---------------------------------------------------------------------------
// upload — abuse limits
// ---------------------------------------------------------------------------

test('a non-video content type is refused', async () => {
  // The bucket is served from the apex domain by the sibling public route, so arbitrary
  // content types here would be a way to host HTML/JS under our own origin.
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ contentType: 'text/html' }), env });
  assert.equal(res.status, 415);
  assert.equal(env.__store.size, 0);
});

test('a declared oversize upload is refused before the body is read', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ contentLength: MAX_RECORDING_BYTES + 1 }), env });
  assert.equal(res.status, 413);
});

test('an ACTUAL oversize body is refused even when Content-Length lied', async () => {
  const env = makeEnv();
  const big = new Uint8Array(MAX_RECORDING_BYTES + 10);
  const res = await upload({ request: uploadReq({ bytes: big, contentLength: 10 }), env });
  assert.equal(res.status, 413);
  assert.equal(env.__store.size, 0, 'an oversize body must never reach storage');
});

test('an empty body is refused', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ bytes: new Uint8Array(0) }), env });
  assert.equal(res.status, 400);
});

test('a membership at its daily quota is refused with 429', async () => {
  const env = makeEnv({ objects: new Array(10).fill({ key: 'x' }) });
  const res = await upload({ request: uploadReq(), env });
  assert.equal(res.status, 429);
  assert.equal(env.__store.size, 0);
});

test('the quota check FAILS CLOSED when storage cannot be listed', async () => {
  const env = makeEnv({ listThrows: true });
  const res = await upload({ request: uploadReq(), env });
  assert.equal(res.status, 503);
  assert.equal(env.__store.size, 0);
});

test('a storage write failure is reported, never a false success', async () => {
  const env = makeEnv({ putThrows: true });
  const res = await upload({ request: uploadReq(), env });
  assert.equal(res.status, 500);
  assert.equal((await body(res)).ok, false);
});

test('GET is not allowed on the upload route', async () => {
  const res = await upload({ request: uploadReq({ method: 'GET' }), env: makeEnv() });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// fetch — THE point of the whole exercise
// ---------------------------------------------------------------------------

async function uploadThenKey(env) {
  const j = await body(await upload({ request: uploadReq(), env }));
  return j.media_key;
}

test('the owner can fetch their own recording back', async () => {
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const res = await fetchMedia({ request: getReq(), env, params: { key: encodeURIComponent(key) } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'video/webm');
});

test('NEGATIVE: an unauthenticated GET is rejected — no licence, no bytes', async () => {
  // This single assertion is why a new route was built instead of reusing
  // GET /api/media/{key}. If it ever goes green-by-accident the feature is a regression.
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const res = await fetchMedia({ request: getReq({ licence: null }), env, params: { key: encodeURIComponent(key) } });
  assert.equal(res.status, 401);
  assert.match((await body(res)).error, /license/i);
});

test('NEGATIVE: an invalid licence cannot fetch a recording', async () => {
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const res = await fetchMedia({ request: getReq({ licence: 'B-NOPE' }), env, params: { key: encodeURIComponent(key) } });
  assert.equal(res.status, 403);
});

test("NEGATIVE: a VALID licence cannot fetch another creator's recording", async () => {
  // "Authenticated" alone would have let every licence holder read every recording. This
  // is the mistake that is easy to make and easy to miss.
  const env = makeEnv();
  const key = await uploadThenKey(env);              // uploaded as mem_123
  const res = await fetchMedia({
    request: getReq({ licence: OTHER_LICENCE }),      // fetched as mem_999
    env,
    params: { key: encodeURIComponent(key) },
  });
  assert.equal(res.status, 403);
});

test('NEGATIVE: the unauthenticated public media route refuses a bug-report key', async () => {
  // Both controls at once — the explicit `bugreport/` refusal AND the key shape.
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const res = await publicMedia({
    request: { method: 'GET', headers: { get: () => null } },
    env,
    params: { key: encodeURIComponent(key) },
  });
  assert.equal(res.status, 400, 'a recording must be unreachable from the public route');
});

test('a bug-report key cannot satisfy the public route KEY_SHAPE either', async () => {
  // Pins control 1 independently of the explicit refusal, so removing either one is a
  // visible test failure rather than a silent loss of defence in depth.
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const PUBLIC_KEY_SHAPE =
    /^([0-9]+|[a-z-]{1,60}-[0-9a-f]{20}|[0-9a-f]{20})\/(reel|cover|carousel)\/[A-Za-z0-9._-]+\.(mp4|mov|jpg|jpeg|png)$/;
  assert.equal(PUBLIC_KEY_SHAPE.test(key), false);
});

test('a scheduled-reel key cannot be laundered through the bug-media route either', async () => {
  const env = makeEnv();
  const res = await fetchMedia({
    request: getReq(),
    env,
    params: { key: encodeURIComponent('12345678901234567/reel/a.mp4') },
  });
  assert.equal(res.status, 400);
});

test('a traversal key is refused on shape, before any storage read', async () => {
  const env = makeEnv();
  for (const bad of ['bugreport/../../etc/passwd', 'bugreport/x/y.webm', '../secret', 'bugreport/' + 'a'.repeat(20) + '/20260101-' + 'b'.repeat(32) + '.html']) {
    const res = await fetchMedia({ request: getReq(), env, params: { key: encodeURIComponent(bad) } });
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
  }
});

test('a malformed percent-encoding is refused without throwing', async () => {
  const res = await fetchMedia({ request: getReq(), env: makeEnv(), params: { key: '%ZZ' } });
  assert.equal(res.status, 400);
});

test('a missing object is 404, not a hang or a 500', async () => {
  const env = makeEnv();
  const slug = await bugMediaSlug(env, 'mem_123');
  const key = `bugreport/${slug}/recording/20260101-${'a'.repeat(32)}.webm`;
  const res = await fetchMedia({ request: getReq(), env, params: { key: encodeURIComponent(key) } });
  assert.equal(res.status, 404);
});

test('an authenticated response is never cacheable and never CORS-readable', async () => {
  const env = makeEnv();
  const key = await uploadThenKey(env);
  const res = await fetchMedia({ request: getReq(), env, params: { key: encodeURIComponent(key) } });
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.match(res.headers.get('Cache-Control'), /private/);
  // The public route sets `*` because Instagram fetches it cross-origin. Echoing that
  // here would let a page on any origin read an authenticated response.
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('ERROR responses are not CORS-readable either, not just the 200', async () => {
  // The inconsistency is the bug: error bodies distinguish "wrong licence" from "not
  // found", which is exactly the probing signal not to hand to a page on another origin.
  const env = makeEnv();
  const key = await uploadThenKey(env);
  for (const licence of [null, 'B-NOPE', OTHER_LICENCE]) {
    const res = await fetchMedia({ request: getReq({ licence }), env, params: { key: encodeURIComponent(key) } });
    assert.ok(res.status >= 400);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, `leaked CORS on ${licence}`);
  }
});

test('POST is not allowed on the fetch route', async () => {
  const res = await fetchMedia({ request: getReq({ method: 'POST' }), env: makeEnv(), params: { key: 'x' } });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// the key-shape helper itself
// ---------------------------------------------------------------------------

test('isBugMediaKey accepts only the minted shape', () => {
  const good = `bugreport/${'a'.repeat(20)}/recording/20260101-${'b'.repeat(32)}.webm`;
  assert.equal(isBugMediaKey(good), true);
  assert.equal(isBugMediaKey(good.replace('.webm', '.mp4')), true);
  for (const bad of [
    null, undefined, 42, '',
    good.replace('bugreport/', 'bugreports/'),
    good.replace('.webm', '.html'),
    good.replace('/recording/', '/'),        // the kind segment is required
    good.replace('/recording/', '/audio/'),  // and it is an enum, not free text
    good + '\n',                     // anchors must be real anchors, not line anchors
    '\n' + good,
    good.replace('/20260101-', '/2026011-'),
  ]) {
    assert.equal(isBugMediaKey(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isCoherentMediaKey rejects a key whose kind and extension disagree', () => {
  // MEDIA_KEY_SHAPE accepts both halves individually. The client picks its preview
  // element from the KIND, so a key that lies about itself renders as a silently broken
  // <audio> the creator cannot check before sending.
  const base = `bugreport/${'a'.repeat(20)}`;
  const stamp = `20260101-${'b'.repeat(32)}`;
  assert.equal(isCoherentMediaKey(`${base}/screenshot/${stamp}.png`), true);
  assert.equal(isCoherentMediaKey(`${base}/voice/${stamp}.ogg`), true);
  assert.equal(isCoherentMediaKey(`${base}/recording/${stamp}.webm`), true);
  assert.equal(isCoherentMediaKey(`${base}/voice/${stamp}.png`), false);
  assert.equal(isCoherentMediaKey(`${base}/screenshot/${stamp}.mp4`), false);
  assert.equal(isCoherentMediaKey(`${base}/recording/${stamp}.ogg`), false);
});

// ---------------------------------------------------------------------------
// three kinds, one pipe — the scope the founder added mid-build
// ---------------------------------------------------------------------------

test('a screenshot and a voice note go through the SAME route and auth', async () => {
  for (const [kind, contentType, ext] of [
    ['screenshot', 'image/png', 'png'],
    ['screenshot', 'image/jpeg', 'jpg'],
    ['voice', 'audio/webm', 'webm'],
    ['voice', 'audio/ogg', 'ogg'],
  ]) {
    const env = makeEnv();
    const j = await body(await upload({ request: uploadReq({ kind, contentType }), env }));
    assert.equal(j.ok, true, `${kind}/${contentType} should be accepted`);
    assert.equal(j.kind, kind);
    assert.ok(j.media_key.includes(`/${kind}/`), 'the kind belongs in the key');
    assert.ok(j.media_key.endsWith(`.${ext}`));
    assert.equal(isCoherentMediaKey(j.media_key), true);
  }
});

test('every kind is subject to the SAME auth — no kind is a side door', async () => {
  for (const kind of Object.keys(MEDIA_KINDS)) {
    const env = makeEnv();
    const res = await upload({ request: uploadReq({ kind, licence: null }), env });
    assert.equal(res.status, 401, `${kind} must require a licence`);
    assert.equal(env.__store.size, 0);
  }
});

test('an unknown kind is refused rather than defaulted', async () => {
  const env = makeEnv();
  const res = await upload({ request: uploadReq({ kind: 'keylogger' }), env });
  assert.equal(res.status, 400);
  assert.equal(env.__store.size, 0);
});

test('content types are allowlisted PER KIND, not shared across them', async () => {
  // A video accepted under kind=screenshot would slip past the screenshot size cap.
  const env = makeEnv();
  assert.equal((await upload({ request: uploadReq({ kind: 'screenshot', contentType: 'video/webm' }), env })).status, 415);
  assert.equal((await upload({ request: uploadReq({ kind: 'voice', contentType: 'image/png' }), env })).status, 415);
  assert.equal((await upload({ request: uploadReq({ kind: 'recording', contentType: 'audio/ogg' }), env })).status, 415);
  assert.equal(env.__store.size, 0);
});

test('each kind carries its own size cap', async () => {
  const env = makeEnv();
  const overScreenshot = new Uint8Array(MEDIA_KINDS.screenshot.maxBytes + 10);
  assert.equal(
    (await upload({ request: uploadReq({ kind: 'screenshot', contentType: 'image/png', bytes: overScreenshot }), env })).status,
    413,
    'a screenshot must not be allowed a recording-sized body',
  );
  assert.equal(env.__store.size, 0);
});

test('quota is per kind — screenshots cannot exhaust the recording allowance', async () => {
  // A creator who took twenty screenshots today must still be able to attach the one
  // recording that actually shows the bug.
  const env = makeEnv({ objects: { '/screenshot/': MEDIA_KINDS.screenshot.dailyQuota } });
  assert.equal(
    (await upload({ request: uploadReq({ kind: 'screenshot', contentType: 'image/png' }), env })).status,
    429,
    'screenshots are over their own quota',
  );
  assert.equal(
    (await upload({ request: uploadReq({ kind: 'recording' }), env })).status,
    200,
    'a full screenshot allowance must not block a recording',
  );
});

test('NEGATIVE: a screenshot and a voice note are just as unfetchable without a licence', async () => {
  for (const [kind, contentType] of [['screenshot', 'image/png'], ['voice', 'audio/ogg']]) {
    const env = makeEnv();
    const j = await body(await upload({ request: uploadReq({ kind, contentType }), env }));
    const res = await fetchMedia({
      request: getReq({ licence: null }), env, params: { key: encodeURIComponent(j.media_key) },
    });
    assert.equal(res.status, 401, `${kind} must not be readable unauthenticated`);
    const other = await fetchMedia({
      request: getReq({ licence: OTHER_LICENCE }), env, params: { key: encodeURIComponent(j.media_key) },
    });
    assert.equal(other.status, 403, `${kind} must not be readable by another licence`);
  }
});

test('NEGATIVE: no kind is reachable from the unauthenticated public media route', async () => {
  for (const [kind, contentType] of [['recording', 'video/webm'], ['screenshot', 'image/png'], ['voice', 'audio/ogg']]) {
    const env = makeEnv();
    const j = await body(await upload({ request: uploadReq({ kind, contentType }), env }));
    const res = await publicMedia({
      request: { method: 'GET', headers: { get: () => null } },
      env,
      params: { key: encodeURIComponent(j.media_key) },
    });
    assert.equal(res.status, 400, `${kind} must be unreachable from the public route`);
  }
});
