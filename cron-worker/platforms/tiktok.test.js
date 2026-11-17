// The TikTok adapter: credentials, chunked upload from R2, status polling, failure classification,
// and its place in the poster. No network: global fetch is replaced. Real SQLite for the credential rows.
// Run: node --test cron-worker/platforms/tiktok.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tiktok } from './tiktok.js';
import { ADAPTERS } from './index.js';
import { processPost } from '../poster.js';
import { encryptToken } from '../_crypto.js';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const TOKEN_ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const MB = 1024 * 1024;
const KEY = '123456/reel/a.mp4';
const noSleep = async () => {};

let db; let env; let calls; let realFetch; let script; let objectSize;

function freshDb() {
  const d = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    try { d.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; }
  }
  return d;
}
function d1(database) {
  return {
    prepare(sql) {
      const stmt = (args) => ({
        async first() { return database.prepare(sql).get(...args) ?? null; },
        async run() { const r = database.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
        async all() { return { results: database.prepare(sql).all(...args) }; },
      });
      return Object.assign(stmt([]), { bind: (...a) => stmt(a) });
    },
  };
}

const jsonRes = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
// Default TikTok responses; a test overrides by path.
const defaults = {
  '/v2/post/publish/creator_info/query/': () => jsonRes({ data: { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } }),
  '/v2/post/publish/video/init/': () => jsonRes({ data: { publish_id: 'pub1', upload_url: 'https://upload.tiktokapis.com/u/1' }, error: { code: 'ok' } }),
  '/v2/post/publish/status/fetch/': () => jsonRes({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } }),
  '/v2/oauth/token/': () => jsonRes({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o' }),
};

beforeEach(async () => {
  db = freshDb();
  objectSize = 3 * MB;
  calls = [];
  script = {};
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, host: u.hostname, method: init.method, headers: init.headers, body: init.body });
    if (u.hostname === 'upload.tiktokapis.com') return (script.upload ? script.upload(init, calls.filter((c) => c.host === u.hostname).length) : jsonRes({}, 201));
    const handler = script[u.pathname] || defaults[u.pathname];
    if (!handler) throw new Error(`unscripted fetch ${url}`);
    return handler(init);
  };
  env = {
    DB: d1(db), TOKEN_ENC_KEY, TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs',
    SCHEDULE_BUCKET: {
      head: async (k) => (k === KEY ? { key: k, size: objectSize, httpMetadata: { contentType: 'video/mp4' } } : null),
      get: async (k, opts) => ({ arrayBuffer: async () => new ArrayBuffer(opts?.range ? opts.range.length : objectSize) }),
    },
  };
  // membership m1 owns IG account 123456 and a TikTok connection.
  db.prepare(`INSERT INTO ig_tokens (ig_user_id, access_token, token_expiry, whop_membership_id) VALUES ('123456','x','2030-01-01','m1')`).run();
  db.prepare(`INSERT INTO whop_memberships (membership_id, whop_user_id, status) VALUES ('m1','u','active')`).run();
  await connect({});
});
afterEach(() => { globalThis.fetch = realFetch; });

async function connect({ expiresInMs = 3600_000 } = {}) {
  db.prepare(`DELETE FROM tiktok_connections`).run();
  db.prepare(`INSERT INTO tiktok_connections (membership_id, open_id, display_name, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at)
              VALUES ('m1','o','n',?,?,?,?)`).run(
    await encryptToken('stored-access', env), await encryptToken('stored-refresh', env),
    new Date(Date.now() + expiresInMs).toISOString(), new Date(Date.now() + 86400_000 * 300).toISOString());
}

const post = (over = {}) => ({
  id: 'p1', ig_user_id: '123456', platform: 'tt', type: 'reel', caption: 'cap', status: 'scheduled', retry_count: 0,
  asset_keys: JSON.stringify([KEY]), post_at: new Date(Date.now() - 1000).toISOString(), tt_publish_id: null,
  tiktok_options: JSON.stringify({ privacy_level: 'SELF_ONLY', cover_timestamp_ms: 0 }), ...over,
});
const deps = (over = {}) => ({ sleepFn: noSleep, pollIntervalMs: 0, pollMaxMs: 50, onMediaPublished: async () => {}, ...over });
const publish = async (p = post(), d = deps()) => {
  const creds = await tiktok.loadCredentials(env, p);
  assert.equal(creds.ok, true, JSON.stringify(creds));
  return tiktok.publish({ post: p, assetKeys: JSON.parse(p.asset_keys), creds: creds.creds, deps: d });
};
const body = (c) => JSON.parse(c.body);

test('TikTok is a registered adapter, and declares the column that records its publish id', () => {
  assert.equal(ADAPTERS.tt, tiktok);
  assert.equal(tiktok.publishedIdColumn, 'tt_publish_id');
});

// ── credentials ─────────────────────────────────────────────────────────────
test('credentials: the stored access token is decrypted and used as-is while it is fresh', async () => {
  const r = await tiktok.loadCredentials(env, post());
  assert.equal(r.ok, true);
  assert.equal(r.creds.accessToken, 'stored-access');
  assert.equal(calls.length, 0);
});

test('credentials: no TikTok connection is a PERMANENT, creator-readable failure', async () => {
  db.prepare(`DELETE FROM tiktok_connections`).run();
  const r = await tiktok.loadCredentials(env, post());
  assert.deepEqual({ ok: r.ok, permanent: r.permanent }, { ok: false, permanent: true });
  assert.match(r.error, /not connected/i);
});

test('credentials: an account with no membership link cannot resolve a connection', async () => {
  db.prepare(`UPDATE ig_tokens SET whop_membership_id = NULL`).run();
  const r = await tiktok.loadCredentials(env, post());
  assert.equal(r.permanent, true);
});

test('credentials: an expiring token is refreshed, saved (encrypted) and used', async () => {
  await connect({ expiresInMs: 10_000 });
  const r = await tiktok.loadCredentials(env, post());
  assert.equal(r.creds.accessToken, 'fresh-access');
  const row = db.prepare(`SELECT access_token_enc FROM tiktok_connections`).get();
  assert.match(row.access_token_enc, /^v1:/);
  assert.notEqual(row.access_token_enc.includes('fresh-access'), true);
});

test('credentials: a refresh TikTok rejects as invalid_grant is permanent (reconnect needed)', async () => {
  await connect({ expiresInMs: 10_000 });
  script['/v2/oauth/token/'] = () => jsonRes({ error: 'invalid_grant', error_description: 'refresh token expired' }, 400);
  const r = await tiktok.loadCredentials(env, post());
  assert.deepEqual({ ok: r.ok, permanent: r.permanent }, { ok: false, permanent: true });
  assert.match(r.error, /reconnect/i);
});

test('credentials: a transient refresh failure is retryable', async () => {
  await connect({ expiresInMs: 10_000 });
  script['/v2/oauth/token/'] = () => { throw new Error('socket hang up'); };
  const r = await tiktok.loadCredentials(env, post());
  assert.deepEqual({ ok: r.ok, permanent: !!r.permanent }, { ok: false, permanent: false });
});

test('credentials: missing TikTok app secrets on the worker is a permanent config failure (needs the founder)', async () => {
  await connect({ expiresInMs: 10_000 });
  delete env.TIKTOK_CLIENT_SECRET;
  const r = await tiktok.loadCredentials(env, post());
  assert.equal(r.permanent, true);
  assert.match(r.error, /TIKTOK_CLIENT_SECRET|not configured/i);
});

// ── publish ─────────────────────────────────────────────────────────────────
test('a small video: creator check → init → one chunk → status; sends the chosen privacy, cover and title', async () => {
  const p = post({ tiktok_options: JSON.stringify({ privacy_level: 'SELF_ONLY', cover_timestamp_ms: 1500, title: 'My title' }) });
  const out = await publish(p);
  assert.deepEqual(calls.map((c) => c.path), [
    '/v2/post/publish/creator_info/query/', '/v2/post/publish/video/init/', '/u/1', '/v2/post/publish/status/fetch/']);
  const init = body(calls[1]);
  assert.equal(init.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(init.post_info.title, 'My title');
  assert.equal(init.post_info.video_cover_timestamp_ms, 1500);
  assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: 3 * MB, chunk_size: 3 * MB, total_chunk_count: 1 });
  assert.equal(calls[2].headers['Content-Range'], `bytes 0-${3 * MB - 1}/${3 * MB}`);
  assert.ok('permalink' in out);
});

test('the title falls back to the caption when none was given', async () => {
  await publish(post({ tiktok_options: JSON.stringify({ privacy_level: 'SELF_ONLY' }) }));
  assert.equal(body(calls[1]).post_info.title, 'cap');
});

test('a 23 MB video goes up as 10 MB + 13 MB (last chunk absorbs the remainder), in order', async () => {
  objectSize = 23 * MB;
  await publish();
  const init = body(calls.find((c) => c.path === '/v2/post/publish/video/init/'));
  assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: 23 * MB, chunk_size: 10 * MB, total_chunk_count: 2 });
  const puts = calls.filter((c) => c.host === 'upload.tiktokapis.com');
  assert.deepEqual(puts.map((c) => c.headers['Content-Range']), [`bytes 0-${10 * MB - 1}/${23 * MB}`, `bytes ${10 * MB}-${23 * MB - 1}/${23 * MB}`]);
  assert.deepEqual(puts.map((c) => c.headers['Content-Length']), [String(10 * MB), String(13 * MB)]);
});

test('the publish id is saved after the LAST chunk and before polling', async () => {
  const order = [];
  script['/v2/post/publish/status/fetch/'] = () => { order.push('status'); return jsonRes({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } }); };
  await publish(post(), deps({ onMediaPublished: async (id) => order.push(`saved:${id}`) }));
  assert.deepEqual(order, ['saved:pub1', 'status']);
});

test('a retry that already has a publish id only polls — no creator query, init or upload', async () => {
  await publish(post({ tt_publish_id: 'pub9' }));
  assert.deepEqual(calls.map((c) => c.path), ['/v2/post/publish/status/fetch/']);
  assert.equal(body(calls[0]).publish_id, 'pub9');
});

test('a privacy level the account does not offer fails permanently BEFORE anything is sent', async () => {
  script['/v2/post/publish/creator_info/query/'] = () => jsonRes({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } });
  await assert.rejects(publish(post({ tiktok_options: JSON.stringify({ privacy_level: 'PUBLIC_TO_EVERYONE' }) })),
    (e) => e.permanent === true && /PUBLIC_TO_EVERYONE/.test(e.message));
  assert.equal(calls.some((c) => c.path.includes('/init/')), false);
});

test('an object missing from storage is permanent', async () => {
  await assert.rejects(publish(post({ asset_keys: JSON.stringify(['123456/reel/gone.mp4']) })), (e) => e.permanent === true);
});

test('TikTok API errors: unaudited-client is permanent, a rate limit is retryable', async () => {
  script['/v2/post/publish/video/init/'] = () => jsonRes({ error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x' } }, 403);
  await assert.rejects(publish(), (e) => e.permanent === true && /unaudited/.test(e.message));
  script['/v2/post/publish/video/init/'] = () => jsonRes({ error: { code: 'rate_limit_exceeded', message: 'slow' } }, 429);
  await assert.rejects(publish(), (e) => !e.permanent);
});

test('a chunk TikTok refuses is a retryable failure naming the status', async () => {
  script.upload = () => jsonRes({}, 500);
  await assert.rejects(publish(), (e) => !e.permanent && /500/.test(e.message));
});

test('an upload URL that is not a TikTok host is never used', async () => {
  script['/v2/post/publish/video/init/'] = () => jsonRes({ data: { publish_id: 'p', upload_url: 'https://evil.example.com/x' }, error: { code: 'ok' } });
  await assert.rejects(publish(), /upload/i);
  assert.equal(calls.some((c) => c.host === 'evil.example.com'), false);
});

test('status FAILED is permanent and carries TikTok\'s reason', async () => {
  script['/v2/post/publish/status/fetch/'] = () => jsonRes({ data: { status: 'FAILED', fail_reason: 'file_format_check_failed' }, error: { code: 'ok' } });
  await assert.rejects(publish(), (e) => e.permanent === true && /file_format_check_failed/.test(e.message));
});

test('still processing at the deadline is retryable, and the publish id was already saved', async () => {
  script['/v2/post/publish/status/fetch/'] = () => jsonRes({ data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } });
  let saved = null;
  await assert.rejects(publish(post(), deps({ onMediaPublished: async (id) => { saved = id; }, pollMaxMs: 5, sleepFn: () => new Promise((r) => setTimeout(r, 3)) })),
    (e) => !e.permanent && /still processing/i.test(e.message));
  assert.equal(saved, 'pub1');
});

test('isAuthExpired recognises TikTok token errors only', () => {
  assert.equal(tiktok.isAuthExpired(new Error('TikTok API error: access_token_invalid — x')), true);
  assert.equal(tiktok.isAuthExpired(new Error('TikTok token error: invalid_grant — x')), true);
  assert.equal(tiktok.isAuthExpired(new Error('TikTok API error: rate_limit_exceeded — x')), false);
});

// ── in the poster ───────────────────────────────────────────────────────────
function seedPost(over = {}) {
  const row = { id: 'p1', ig_user_id: '123456', platform: 'tt', type: 'reel', asset_keys: JSON.stringify([KEY]), caption: 'cap',
    post_at: new Date(Date.now() - 60_000).toISOString(), status: 'scheduled', retry_count: 0,
    tiktok_options: JSON.stringify({ privacy_level: 'SELF_ONLY' }), ...over };
  db.prepare(`INSERT INTO scheduled_posts (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return db.prepare(`SELECT * FROM scheduled_posts WHERE id = ?`).get(row.id);
}
const run = (p) => processPost(env, p, undefined, noSleep, 0, 50);
const state = () => db.prepare(`SELECT status, retry_count, error, tt_publish_id FROM scheduled_posts WHERE id='p1'`).get();

test('poster: a due TikTok post publishes, is marked posted and keeps its publish id', async () => {
  await run(seedPost());
  assert.deepEqual({ ...state() }, { status: 'posted', retry_count: 0, error: null, tt_publish_id: 'pub1' });
});

test('poster: a permanent TikTok failure is failed at once with a readable error — not retried', async () => {
  script['/v2/post/publish/video/init/'] = () => jsonRes({ error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x' } }, 403);
  await run(seedPost());
  const s = state();
  assert.equal(s.status, 'failed');
  assert.equal(s.retry_count, 0);
  assert.match(s.error, /unaudited/);
});

test('poster: a transient TikTok failure is requeued and counted', async () => {
  script['/v2/post/publish/video/init/'] = () => jsonRes({ error: { code: 'rate_limit_exceeded', message: 'x' } }, 429);
  await run(seedPost());
  assert.deepEqual({ status: state().status, retry_count: state().retry_count }, { status: 'scheduled', retry_count: 1 });
});

test('poster: an expired TikTok token fails with the TOKEN_EXPIRED sentinel', async () => {
  script['/v2/post/publish/creator_info/query/'] = () => jsonRes({ error: { code: 'access_token_invalid', message: 'x' } }, 401);
  await run(seedPost());
  assert.equal(state().error, 'TOKEN_EXPIRED');
});
