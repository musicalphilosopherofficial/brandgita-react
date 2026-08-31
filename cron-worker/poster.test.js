// Characterization tests for cron-worker/poster.js — run with:
//   node --test cron-worker/poster.test.js
// Written BEFORE a planned restructure of poster.js (the Graph-request code
// moves into platforms/instagram.js), to pin its current behaviour so that
// extraction is provably behaviour-preserving. Mutation-tested against the
// architect's 14 plausible extraction slips: every test below asserts the
// actual Graph request PAYLOAD (path, form params, access_token), not just
// "a call happened" — a call-count-only assertion survives a dropped caption
// or a hardcoded wrong account id, which defeats the point of this suite.
//
// No deps: Node's built-in test runner, a fake D1 that tracks row state in
// memory (same SQL-text-dispatch convention as functions/api/schedule.patch.test.js),
// and a globalThis.fetch stub returning canned Graph API JSON (same convention
// as functions/api/token.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import posterDefault, {
  processPost, refreshExpiringTokens, claimPost, runDue,
} from './poster.js';

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';
const MEDIA_BASE = 'https://test-media.example/media';
// Valid base64 of 32 random bytes — same fixture key used in functions/api/token.test.js.
const TOKEN_ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

// sleepFn injected everywhere so the 10s real poll interval collapses to
// ~0ms. Note this does NOT affect waitForContainerReady's deadline — that's
// real wall-clock Date.now(), which is why the timeout test below separately
// overrides pollMaxMs to a few milliseconds. Deliberately a real macrotask
// (setTimeout) rather than a bare `Promise.resolve()`: a microtask-only
// resolution lets a poll loop that never reaches FINISHED/ERROR/EXPIRED spin
// as an unbroken microtask chain, which starves Node's timer phase and can
// hang the process past any --test-timeout — happened while mutation-testing
// this file (removing the ERROR/EXPIRED branch hung instead of failing fast).
const instantSleep = () => new Promise((resolve) => setTimeout(resolve, 0));

function mediaCreateUrl(igUserId) { return `${GRAPH_BASE}/${igUserId}/media`; }
function mediaPublishUrl(igUserId) { return `${GRAPH_BASE}/${igUserId}/media_publish`; }

// ---------------------------------------------------------------------------
// Fake D1 — dispatches on SQL text against in-memory `scheduled_posts` /
// `ig_tokens` tables so claimPost's CAS, the retry/permanent-fail branches,
// and the due-query's own predicates (status, retry_count, LIMIT) can be
// asserted against real row-state transitions, not just call recording.
// ---------------------------------------------------------------------------
function makeEnv({ posts = {}, tokens = {}, breakWriteWhen = null, breakDueQuery = false, breakCountQuery = false } = {}) {
  // Deep-clone the seed rows so each test gets its own mutable state.
  const state = {
    posts: JSON.parse(JSON.stringify(posts)),
    tokens: JSON.parse(JSON.stringify(tokens)),
  };
  const writes = [];

  function statement(sql) {
    const bound = (args) => ({
      async first() { return execFirst(sql, args); },
      async run() { return execRun(sql, args); },
      async all() { return execAll(sql, args); },
    });
    // Some queries in poster.js call .all()/.first() directly with no .bind()
    // (e.g. the due-posts query, the token-refresh sweep) — support both forms.
    return Object.assign(bound([]), { bind: (...args) => bound(args) });
  }

  function execFirst(sql, args) {
    if (sql.includes('SELECT access_token FROM ig_tokens WHERE ig_user_id = ?')) {
      const [igUserId] = args;
      return state.tokens[igUserId] || null;
    }
    // Diagnostic denominators for the "matched X of Y" logs. Mirror the real
    // predicates for the same reason execAll does: countRows() swallows every
    // failure by design, so a fake that threw here would leave the denominator
    // silently rendering '?' in every test while the suite still went green —
    // which is precisely the blindness these logs exist to remove.
    // Checked BEFORE the handlers below — placed after them it could never fire,
    // since each returns first.
    if (breakCountQuery && sql.includes('COUNT(*) AS n')) {
      throw new Error('D1 down (simulated count failure)');
    }
    if (sql.includes('COUNT(*) AS n FROM scheduled_posts')) {
      let rows = Object.values(state.posts);
      if (sql.includes(`status = 'scheduled'`)) rows = rows.filter((r) => r.status === 'scheduled');
      if (sql.includes('retry_count < 5')) rows = rows.filter((r) => (r.retry_count ?? 0) < 5);
      return { n: rows.length };
    }
    if (sql.includes('COUNT(*) AS n FROM ig_tokens')) {
      return { n: Object.values(state.tokens).length };
    }
    throw new Error(`fake D1: unhandled .first() SQL: ${sql}`);
  }

  function execAll(sql) {
    if (sql.includes('SELECT * FROM scheduled_posts')) {
      if (breakDueQuery) throw new Error('D1 down (simulated due-query failure)');
      // Mirror the real predicates so tests can prove the SQL actually asks
      // for them, rather than trusting the SQL text alone: if a Wave-3
      // extraction accidentally drops "LIMIT 10" or the retry_count filter,
      // this fake stops applying it too, and more rows come back than a test
      // expects.
      let rows = Object.values(state.posts);
      if (sql.includes(`status = 'scheduled'`)) rows = rows.filter((r) => r.status === 'scheduled');
      if (sql.includes('retry_count < 5')) rows = rows.filter((r) => (r.retry_count ?? 0) < 5);
      if (sql.includes('LIMIT 10')) rows = rows.slice(0, 10);
      return { results: rows };
    }
    if (sql.includes('SELECT ig_user_id, access_token FROM ig_tokens')) {
      return { results: Object.values(state.tokens) };
    }
    throw new Error(`fake D1: unhandled .all() SQL: ${sql}`);
  }

  function execRun(sql, args) {
    writes.push({ sql, args });
    if (breakWriteWhen && breakWriteWhen(sql, args)) {
      throw new Error('D1 down (simulated write failure)');
    }

    if (sql.includes(`SET status = 'posting'`)) {
      const [id] = args;
      const row = state.posts[id];
      if (row && row.status === 'scheduled') {
        row.status = 'posting';
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes(`SET status = 'posted'`)) {
      const [permalink, id] = args;
      const row = state.posts[id];
      if (row) { row.status = 'posted'; row.permalink = permalink; row.error = null; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    // Permanent failure via handleRetryableFailure (has retry_count) — check
    // BEFORE the plain markFailed pattern, since both contain "status = 'failed'".
    if (sql.includes(`SET status = 'failed', retry_count = ?`)) {
      const [retryCount, errorText, id] = args;
      const row = state.posts[id];
      if (row) { row.status = 'failed'; row.retry_count = retryCount; row.error = errorText; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes(`SET status = 'scheduled', retry_count = ?`)) {
      const [retryCount, errorText, id] = args;
      const row = state.posts[id];
      if (row) { row.status = 'scheduled'; row.retry_count = retryCount; row.error = errorText; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    // Plain permanent failure via markFailed (no retry_count column touched).
    if (sql.includes(`SET status = 'failed', error = ? WHERE id = ?`)) {
      const [errorText, id] = args;
      const row = state.posts[id];
      if (row) { row.status = 'failed'; row.error = errorText; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes('UPDATE ig_tokens SET access_token = ?, token_expiry = ?, updated_at = ?')) {
      const [accessToken, tokenExpiry, updatedAt, igUserId] = args;
      const row = state.tokens[igUserId];
      if (row) { row.access_token = accessToken; row.token_expiry = tokenExpiry; row.updated_at = updatedAt; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`fake D1: unhandled .run() SQL: ${sql}`);
  }

  const env = {
    DB: { prepare: (sql) => statement(sql) },
    TOKEN_ENC_KEY,
  };
  return { env, state, writes };
}

const post = (over = {}) => ({
  id: 'post-1',
  ig_user_id: 'ig-user-1',
  type: 'reel',
  asset_keys: JSON.stringify(['clip.mp4']),
  cover_key: null,
  caption: 'hello',
  status: 'scheduled',
  retry_count: 0,
  permalink: null,
  error: null,
  ...over,
});

const tokenRow = (over = {}) => ({
  ig_user_id: 'ig-user-1',
  access_token: 'plaintext-token', // no "v1:" prefix -> decryptToken passes it through untouched
  token_expiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

// Records every fetch call, with the POST body parsed into URLSearchParams so
// assertions can check exact param values (`body.get('caption')`) instead of
// fragile substring/encoding matches. Dispatches to per-test rule list; each
// rule is [predicate(url, opts, body), responseFactory(url, opts, body)],
// first match wins.
function makeFetchMock(rules) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const bodyStr = opts?.body ? String(opts.body) : null;
    const body = bodyStr ? new URLSearchParams(bodyStr) : null;
    calls.push({ url: u, method: opts?.method || 'GET', body });
    for (const [match, respond] of rules) {
      if (match(u, opts, body)) return respond(u, opts, body);
    }
    throw new Error(`unmocked fetch: ${u}${bodyStr ? ` body=${bodyStr}` : ''}`);
  };
  return calls;
}

function jsonOk(body) {
  return { ok: true, json: async () => body };
}
// A genuine HTTP-level failure (res.ok === false) with NO embedded `error`
// field — distinct from jsonOk-with-error-payload, and the only way to
// exercise the `!res.ok` half of igPost/igGet's `if (!res.ok || data?.error)`
// guard rather than always taking the `data?.error` branch.
function httpError(status, body = {}) {
  return { ok: false, status, json: async () => body };
}

const isCreate = (u, opts) => opts?.method === 'POST' && u.endsWith('/media');
const isPublish = (u, opts) => opts?.method === 'POST' && u.endsWith('/media_publish');
const isPollStatus = (u) => u.includes('fields=status_code');
const isPermalink = (u) => u.includes('fields=permalink');

// ---------------------------------------------------------------------------
// claimPost — the overlapping-runs CAS guard
// ---------------------------------------------------------------------------

test('claimPost: two overlapping runs on one row — only the first wins', async () => {
  const { env } = makeEnv({ posts: { 'post-1': post() } });

  const won1 = await claimPost(env, 'post-1');
  const won2 = await claimPost(env, 'post-1');

  assert.equal(won1, true, 'first claim flips scheduled -> posting and wins');
  assert.equal(won2, false, 'second overlapping claim on the same row loses');
});

test('processPost: a post already claimed by another run makes zero Graph calls', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ status: 'posting' }) }, // already claimed by "another" run
    tokens: { 'ig-user-1': tokenRow() },
  });
  const calls = makeFetchMock([]);

  await processPost(env, post({ status: 'posting' }), MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0, 'a post that failed to claim must never touch the Graph API');
  assert.equal(state.posts['post-1'].status, 'posting', 'row untouched by the losing run');
});

// ---------------------------------------------------------------------------
// Reel happy path — full request-payload assertions (catches: dropped
// caption, missing access_token, wrong/hardcoded account path)
// ---------------------------------------------------------------------------

test('reel happy path: create -> poll (IN_PROGRESS then FINISHED) -> publish -> permalink -> posted', async () => {
  const igUserId = 'acct-reel-distinctive'; // distinctive id so a hardcoded wrong account can't accidentally match
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ ig_user_id: igUserId, type: 'reel', asset_keys: JSON.stringify(['clip.mp4']) }) },
    tokens: { [igUserId]: tokenRow({ ig_user_id: igUserId, access_token: 'reel-token' }) },
  });

  let pollCount = 0;
  const calls = makeFetchMock([
    [isCreate, (u, opts, body) => {
      assert.equal(u, mediaCreateUrl(igUserId), 'container create must POST to this exact account\'s /media path');
      assert.equal(body.get('media_type'), 'REELS');
      assert.equal(body.get('video_url'), `${MEDIA_BASE}/clip.mp4`);
      assert.equal(body.get('caption'), 'hello', 'caption must be forwarded to the container');
      assert.equal(body.get('cover_url'), null, 'no cover_key on this fixture -> no cover_url param');
      assert.equal(body.get('access_token'), 'reel-token', 'access_token must be present on the create call');
      return jsonOk({ id: 'container-1' });
    }],
    [isPollStatus, (u) => {
      assert.ok(u.startsWith(`${GRAPH_BASE}/container-1?`), 'poll must target the returned container id');
      pollCount += 1;
      return jsonOk({ status_code: pollCount < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    }],
    [isPublish, (u, opts, body) => {
      assert.equal(u, mediaPublishUrl(igUserId), 'publish must POST to this exact account\'s /media_publish path');
      assert.equal(body.get('creation_id'), 'container-1');
      assert.equal(body.get('access_token'), 'reel-token', 'access_token must be present on the publish call');
      return jsonOk({ id: 'media-1' });
    }],
    [isPermalink, (u) => {
      assert.ok(u.startsWith(`${GRAPH_BASE}/media-1?`), 'permalink GET must target the published media id');
      return jsonOk({ permalink: 'https://www.instagram.com/reel/abc123/' });
    }],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(pollCount, 2, 'polled until FINISHED');
  assert.equal(calls.filter((c) => isCreate(c.url, c)).length, 1);
  assert.equal(calls.filter((c) => isPublish(c.url, c)).length, 1);
  assert.equal(state.posts['post-1'].status, 'posted');
  assert.equal(state.posts['post-1'].permalink, 'https://www.instagram.com/reel/abc123/');
  assert.equal(state.posts['post-1'].error, null);
});

test('reel with a cover_key: cover_url is derived from it via mediaUrl', async () => {
  const igUserId = 'acct-reel-cover';
  const { env, state } = makeEnv({
    posts: {
      'post-1': post({
        ig_user_id: igUserId, type: 'reel',
        asset_keys: JSON.stringify(['clip.mp4']), cover_key: 'covers/frame1.jpg',
      }),
    },
    tokens: { [igUserId]: tokenRow({ ig_user_id: igUserId }) },
  });

  makeFetchMock([
    [isCreate, (u, opts, body) => {
      assert.equal(body.get('cover_url'), `${MEDIA_BASE}/covers/frame1.jpg`, 'cover_key must produce a cover_url via mediaUrl');
      return jsonOk({ id: 'container-1' });
    }],
    [isPollStatus, () => jsonOk({ status_code: 'FINISHED' })],
    [isPublish, () => jsonOk({ id: 'media-1' })],
    [isPermalink, () => jsonOk({ permalink: 'https://www.instagram.com/reel/cov/' })],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'posted');
});

test('reel container status ERROR aborts the poll and is treated as retryable', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({ id: 'container-1' })],
    [isPollStatus, () => jsonOk({ status_code: 'ERROR' })],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'scheduled');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /returned status ERROR/);
});

test('reel container status EXPIRED aborts the poll and is treated as retryable', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({ id: 'container-1' })],
    [isPollStatus, () => jsonOk({ status_code: 'EXPIRED' })],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'scheduled');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /returned status EXPIRED/);
});

test('reel container that never reaches FINISHED times out and is treated as retryable', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({ id: 'container-1' })],
    [isPollStatus, () => jsonOk({ status_code: 'IN_PROGRESS' })], // never finishes
  ]);

  // pollMaxMs overridden to a few real milliseconds — the deadline check is
  // real Date.now() regardless of sleepFn, so without this override the loop
  // would spin for the real 5-minute production deadline.
  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep, 0, 20);

  assert.equal(state.posts['post-1'].status, 'scheduled');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /did not finish within/);
});

// ---------------------------------------------------------------------------
// Carousel happy path — full request-payload assertions
// ---------------------------------------------------------------------------

test('carousel happy path: N children -> parent -> publish -> permalink -> posted', async () => {
  const igUserId = 'acct-carousel-distinctive';
  const assetKeys = ['a.jpg', 'b.jpg', 'c.jpg'];
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ ig_user_id: igUserId, type: 'carousel', asset_keys: JSON.stringify(assetKeys) }) },
    tokens: { [igUserId]: tokenRow({ ig_user_id: igUserId, access_token: 'carousel-token' }) },
  });

  const seenChildImageUrls = [];
  const createdChildIds = [];
  makeFetchMock([
    [(u, opts, body) => isCreate(u, opts) && body.get('is_carousel_item') === 'true', (u, opts, body) => {
      assert.equal(u, mediaCreateUrl(igUserId));
      assert.equal(body.get('access_token'), 'carousel-token');
      seenChildImageUrls.push(body.get('image_url'));
      const id = `child-${createdChildIds.length + 1}`;
      createdChildIds.push(id);
      return jsonOk({ id });
    }],
    [(u, opts, body) => isCreate(u, opts) && body.get('media_type') === 'CAROUSEL', (u, opts, body) => {
      assert.equal(u, mediaCreateUrl(igUserId));
      assert.equal(body.get('caption'), 'hello', 'caption must be forwarded to the carousel parent container');
      assert.equal(body.get('children'), createdChildIds.join(','), 'children must list exactly the created child ids, in order');
      assert.equal(body.get('access_token'), 'carousel-token');
      return jsonOk({ id: 'carousel-parent-1' });
    }],
    [isPublish, (u, opts, body) => {
      assert.equal(u, mediaPublishUrl(igUserId));
      assert.equal(body.get('creation_id'), 'carousel-parent-1');
      return jsonOk({ id: 'media-1' });
    }],
    [isPermalink, () => jsonOk({ permalink: 'https://www.instagram.com/p/def456/' })],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(createdChildIds.length, 3, 'one child container per asset');
  assert.deepEqual(seenChildImageUrls, assetKeys.map((k) => `${MEDIA_BASE}/${k}`), 'each child gets its own asset key mediaUrl');
  assert.equal(state.posts['post-1'].status, 'posted');
  assert.equal(state.posts['post-1'].permalink, 'https://www.instagram.com/p/def456/');
});

test('carousel with 1 asset throws before any Graph call — retried as a transient error', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'carousel', asset_keys: JSON.stringify(['only-one.jpg']), retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  const calls = makeFetchMock([]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0, 'the length guard fires before any igPost/igGet call');
  assert.equal(state.posts['post-1'].status, 'scheduled', 'treated as a retryable error, requeued');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /at least 2/);
});

// ---------------------------------------------------------------------------
// Unknown type
// ---------------------------------------------------------------------------

test('unknown post type -> markFailed, retry_count NOT incremented', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'story', retry_count: 2 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  const calls = makeFetchMock([]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0);
  assert.equal(state.posts['post-1'].status, 'failed');
  assert.equal(state.posts['post-1'].retry_count, 2, 'markFailed never touches retry_count');
  assert.match(state.posts['post-1'].error, /Unknown post type: story/);
});

// ---------------------------------------------------------------------------
// Graph error code 190 (expired/invalid token)
// ---------------------------------------------------------------------------

test('Graph error code 190 -> markFailed(TOKEN_EXPIRED) regardless of retry_count', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 3 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({ error: { code: 190, message: 'Error validating access token' } })],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'failed');
  assert.equal(state.posts['post-1'].error, 'TOKEN_EXPIRED');
  assert.equal(state.posts['post-1'].retry_count, 3, 'markFailed leaves retry_count untouched');
});

// ---------------------------------------------------------------------------
// A genuine HTTP-level failure (res.ok === false, no embedded error object) —
// exercises the `!res.ok` half of the igPost/igGet guard, which a
// jsonOk-shaped-but-marked-ok:false stub never reached before.
// ---------------------------------------------------------------------------

test('a plain HTTP error (ok:false, no error body) from Graph is retried, not swallowed', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => httpError(500, {})],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'scheduled');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /HTTP 500/);
});

// ---------------------------------------------------------------------------
// Other (non-190) errors — retry then permanent-fail cap
// ---------------------------------------------------------------------------

test('other error at retry_count=0 -> requeued, status=scheduled, retry_count=1', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 0 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({})], // no `id` field -> "Reel container creation returned no id"
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'scheduled');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.match(state.posts['post-1'].error, /no id/);
});

test('other error at retry_count=4 (the 5th attempt) -> permanent fail, status=failed, retry_count=5', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ type: 'reel', retry_count: 4 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({})],
  ]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(state.posts['post-1'].status, 'failed');
  assert.equal(state.posts['post-1'].retry_count, 5);
});

// ---------------------------------------------------------------------------
// No token row
// ---------------------------------------------------------------------------

test('no ig_tokens row for the user -> markFailed("No token for user"), permanent', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ retry_count: 1 }) },
    tokens: {}, // no row for ig-user-1
  });
  const calls = makeFetchMock([]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0, 'never reaches the Graph API without a token');
  assert.equal(state.posts['post-1'].status, 'failed');
  assert.equal(state.posts['post-1'].error, 'No token for user');
  assert.equal(state.posts['post-1'].retry_count, 1, 'markFailed leaves retry_count untouched');
});

// ---------------------------------------------------------------------------
// Decrypt throws -> retryable, not permanent
// ---------------------------------------------------------------------------

test('a decrypt failure is retryable, not permanent', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ retry_count: 0 }) },
    // "v1:"-prefixed but the env has no TOKEN_ENC_KEY, so importKey() throws inside decryptToken.
    tokens: { 'ig-user-1': tokenRow({ access_token: 'v1:not-a-real-iv:not-real-ciphertext' }) },
  });
  delete env.TOKEN_ENC_KEY;
  const calls = makeFetchMock([]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0, 'decrypt fails before any Graph call');
  assert.equal(state.posts['post-1'].status, 'scheduled', 'retryable, not markFailed');
  assert.equal(state.posts['post-1'].retry_count, 1);
  assert.equal(state.posts['post-1'].error, 'Token decrypt failed');
});

// ---------------------------------------------------------------------------
// Malformed asset_keys -> PERMANENT failure (markFailed), retry_count untouched
// ---------------------------------------------------------------------------

test('malformed asset_keys JSON -> markFailed, permanent, retry_count untouched', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post({ asset_keys: '{not valid json', retry_count: 3 }) },
    tokens: { 'ig-user-1': tokenRow() },
  });
  const calls = makeFetchMock([]);

  await processPost(env, state.posts['post-1'], MEDIA_BASE, instantSleep);

  assert.equal(calls.length, 0, 'JSON parse failure fires before any Graph call');
  assert.equal(state.posts['post-1'].status, 'failed', 'permanent, not requeued');
  assert.equal(state.posts['post-1'].retry_count, 3, 'markFailed leaves retry_count untouched');
  assert.match(state.posts['post-1'].error, /Invalid asset_keys JSON/);
});

// ---------------------------------------------------------------------------
// runDue — the due-query + per-post loop extracted out of scheduled()
// ---------------------------------------------------------------------------

test('runDue: one post throwing out of processPost does not stop the next post from processing', async () => {
  const igUserId = 'ig-user-1';
  const { env, state } = makeEnv({
    posts: {
      'post-throws': post({ id: 'post-throws', type: 'carousel', asset_keys: JSON.stringify(['x.jpg', 'y.jpg']), retry_count: 0 }),
      'post-ok': post({ id: 'post-ok', type: 'carousel', asset_keys: JSON.stringify(['x.jpg', 'y.jpg']), retry_count: 0 }),
    },
    tokens: { [igUserId]: tokenRow() },
    // Simulates the claim UPDATE itself throwing (e.g. D1 down) for one row —
    // an error escaping processPost entirely, as opposed to one it already handled.
    breakWriteWhen: (sql, args) => sql.includes(`SET status = 'posting'`) && args[0] === 'post-throws',
  });
  let childSeq = 0;
  makeFetchMock([
    [(u, opts, body) => isCreate(u, opts) && body.get('is_carousel_item') === 'true', () => jsonOk({ id: `child-${++childSeq}` })],
    [(u, opts, body) => isCreate(u, opts) && body.get('media_type') === 'CAROUSEL', () => jsonOk({ id: 'carousel-parent' })],
    [isPublish, () => jsonOk({ id: 'media-1' })],
    [isPermalink, () => jsonOk({ permalink: 'https://www.instagram.com/p/ok/' })],
  ]);

  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.equal(state.posts['post-throws'].status, 'scheduled', 'claim failure recorded as retryable via the outer catch');
  assert.equal(state.posts['post-throws'].retry_count, 1);
  assert.equal(state.posts['post-ok'].status, 'posted', 'the next post in the loop still completes');
});

test('runDue: a post whose retry-failure write ALSO throws does not abort the batch (double catch)', async () => {
  const igUserId = 'ig-user-1';
  const { env, state } = makeEnv({
    posts: {
      'post-throws': post({ id: 'post-throws', type: 'carousel', asset_keys: JSON.stringify(['x.jpg', 'y.jpg']), retry_count: 0 }),
      'post-ok': post({ id: 'post-ok', type: 'carousel', asset_keys: JSON.stringify(['x.jpg', 'y.jpg']), retry_count: 0 }),
    },
    tokens: { [igUserId]: tokenRow() },
    // BOTH the claim write for post-throws AND the outer catch's subsequent
    // handleRetryableFailure requeue-write for post-throws fail. This is the
    // innermost try/catch in runDue's loop body (`catch (innerErr) {...}`).
    breakWriteWhen: (sql, args) => (
      (sql.includes(`SET status = 'posting'`) && args[0] === 'post-throws') ||
      (sql.includes(`SET status = 'scheduled', retry_count = ?`) && args[2] === 'post-throws')
    ),
  });
  let childSeq = 0;
  makeFetchMock([
    [(u, opts, body) => isCreate(u, opts) && body.get('is_carousel_item') === 'true', () => jsonOk({ id: `child-${++childSeq}` })],
    [(u, opts, body) => isCreate(u, opts) && body.get('media_type') === 'CAROUSEL', () => jsonOk({ id: 'carousel-parent' })],
    [isPublish, () => jsonOk({ id: 'media-1' })],
    [isPermalink, () => jsonOk({ permalink: 'https://www.instagram.com/p/ok/' })],
  ]);

  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.equal(state.posts['post-throws'].status, 'scheduled', 'both writes failed -> row left in its original state');
  assert.equal(state.posts['post-throws'].retry_count, 0, 'the requeue write never actually landed');
  assert.equal(state.posts['post-ok'].status, 'posted', 'a second failure on one row still does not abort the batch');
});

test('runDue: only the LIMIT 10 due posts are processed, not more', async () => {
  const igUserId = 'ig-user-1';
  const posts = {};
  for (let i = 1; i <= 12; i++) {
    posts[`post-${i}`] = post({ id: `post-${i}`, type: 'story' }); // "story" resolves instantly via markFailed, no Graph calls
  }
  const { env, state } = makeEnv({ posts, tokens: { [igUserId]: tokenRow() } });
  makeFetchMock([]);

  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  const processedCount = Object.values(state.posts).filter((p) => p.status === 'failed').length;
  const untouchedCount = Object.values(state.posts).filter((p) => p.status === 'scheduled').length;
  assert.equal(processedCount, 10, 'the due query is capped at 10 rows');
  assert.equal(untouchedCount, 2, 'rows beyond the cap are left for the next cron tick');
});

test('runDue: posts at or above the retry cap (retry_count >= 5) are excluded from the due query', async () => {
  const igUserId = 'ig-user-1';
  const { env, state } = makeEnv({
    posts: {
      'post-capped': post({ id: 'post-capped', type: 'story', retry_count: 5 }),
      'post-under-cap': post({ id: 'post-under-cap', type: 'story', retry_count: 4 }),
    },
    tokens: { [igUserId]: tokenRow() },
  });
  makeFetchMock([]);

  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.equal(state.posts['post-capped'].status, 'scheduled', 'retry_count=5 is excluded by "retry_count < 5"');
  assert.equal(state.posts['post-capped'].retry_count, 5, 'never touched');
  assert.equal(state.posts['post-under-cap'].status, 'failed', 'retry_count=4 is still under the cap and gets processed');
});

// ---------------------------------------------------------------------------
// scheduled() — the thin cron adapter: runDue() then the refresh pass,
// unconditionally even if the due-posts query itself failed.
// ---------------------------------------------------------------------------

test('scheduled(): the token-refresh pass still runs even when the due-posts query itself fails', async () => {
  const { env, state } = makeEnv({
    breakDueQuery: true,
    tokens: { 'user-good': tokenRow({ ig_user_id: 'user-good', access_token: 'old-plaintext-good' }) },
  });
  makeFetchMock([
    [(u) => u.includes('refresh_access_token'), () => jsonOk({ access_token: 'new-long-tok', expires_in: 5_184_000 })],
  ]);

  await posterDefault.scheduled({}, env, {});

  assert.equal(state.tokens['user-good'].access_token.startsWith('v1:'), true, 'refresh pass ran and re-encrypted the token despite the due query throwing');
});

test('a failing diagnostic count NEVER blocks posting — the denominator degrades, the run does not', async () => {
  // The "matched X of Y" denominator exists to make a silent bug visible. A
  // denominator that could itself break posting would be a strictly worse bug
  // than the blindness it fixes, so countRows() swallows everything and returns
  // null. This proves that contract against the real code path, not by reading it.
  const { env, state } = makeEnv({
    breakCountQuery: true,
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow() },
  });
  makeFetchMock([
    [isCreate, () => jsonOk({ id: 'container-1' })],
    [isPollStatus, () => jsonOk({ status_code: 'FINISHED' })],
    [isPublish, () => jsonOk({ id: 'media-1' })],
    [isPermalink, () => jsonOk({ permalink: 'https://instagram.com/p/abc' })],
    [(u) => u.includes('refresh_access_token'),
      () => jsonOk({ access_token: 'new-long-tok', expires_in: 5_184_000 })],
  ]);

  await posterDefault.scheduled({}, env, {});

  assert.equal(
    state.posts['post-1'].status,
    'posted',
    'the post still published even though its diagnostic count query threw'
  );
});

// ---------------------------------------------------------------------------
// Token refresh sweep
// ---------------------------------------------------------------------------

test('refresh sweep updates a row with its new expiry; one user failing does not abort the rest', async () => {
  const { env, state } = makeEnv({
    tokens: {
      'user-good': tokenRow({ ig_user_id: 'user-good', access_token: 'old-plaintext-good' }),
      'user-bad': tokenRow({ ig_user_id: 'user-bad', access_token: 'old-plaintext-bad' }),
    },
  });

  makeFetchMock([
    [(u) => u.includes('refresh_access_token') && u.includes('old-plaintext-good'),
      () => jsonOk({ access_token: 'new-long-tok', expires_in: 5_184_000 })],
    [(u) => u.includes('refresh_access_token') && u.includes('old-plaintext-bad'),
      () => { throw new Error('network down for user-bad'); }],
  ]);

  await refreshExpiringTokens(env);

  assert.equal(state.tokens['user-good'].access_token.startsWith('v1:'), true, 'refreshed token stored encrypted');
  assert.notEqual(state.tokens['user-good'].access_token, 'old-plaintext-good');
  assert.equal(state.tokens['user-bad'].access_token, 'old-plaintext-bad', 'a failed refresh leaves the row untouched');
});
