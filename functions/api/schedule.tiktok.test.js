// TikTok through /api/schedule: create, duplicate guard, list filters, PATCH. Real SQLite.
// Run: node --test functions/api/schedule.tiktok.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as schedule } from './schedule.js';
import { onRequest as scheduleId } from './schedule/[id].js';

const OWNER = '123456';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const futureISO = (d = 5) => new Date(Date.now() + d * 864e5).toISOString();
let db; let env;

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
        async first() {
          if (sql.includes('ig_tokens')) return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
          return database.prepare(sql).get(...args) ?? null;
        },
        async run() { const r = database.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
        async all() { return { results: database.prepare(sql).all(...args) }; },
      });
      return Object.assign(stmt([]), { bind: (...a) => stmt(a) });
    },
  };
}
beforeEach(() => {
  db = freshDb();
  env = { DB: d1(db), SCHEDULE_BUCKET: { head: async (k) => ({ key: k }), delete: async () => {}, put: async () => {} } };
});

const req = (method, body, url = 'https://brandgita.com/api/schedule') =>
  ({ method, url, headers: { get: (k) => (k === 'Authorization' ? 'Bearer tok' : null) }, json: async () => body });
const KEY = `${OWNER}/reel/a.mp4`;
const body = (over = {}) => ({ id: 'p1', platform: 'tiktok', asset_keys: [KEY], post_at: futureISO(), ...over });
const create = async (over) => { const r = await schedule({ request: req('POST', body(over)), env }); return { status: r.status, data: await r.json() }; };
const row = (id = 'p1') => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);

test('a TikTok post saves with platform tt, defaults SELF_ONLY / cover 0, and replies { ok, id, post_at }', async () => {
  const { status, data } = await create({ title: 'hi' });
  assert.equal(status, 200);
  assert.deepEqual({ ok: data.ok, id: data.id, post_at: typeof data.post_at }, { ok: true, id: 'p1', post_at: 'string' });
  const r = row();
  assert.equal(r.platform, 'tt');
  assert.equal(r.type, 'reel');
  assert.deepEqual(JSON.parse(r.tiktok_options), { privacy_level: 'SELF_ONLY', cover_timestamp_ms: 0, title: 'hi' });
});

test('caption is optional for TikTok (title or nothing); the old IG rule that caption is required is unchanged', async () => {
  assert.equal((await create({})).status, 200);
  const ig = await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [KEY], post_at: futureISO() }), env });
  assert.equal(ig.status, 400);
});

test('"tt" and "tiktok" are the same platform', async () => {
  assert.equal((await create({ platform: 'tt' })).status, 200);
  assert.equal(row().platform, 'tt');
});

test('invalid TikTok options are rejected with every problem named', async () => {
  const { status, data } = await create({ privacy_level: 'EVERYONE', cover_timestamp_ms: -5 });
  assert.equal(status, 400);
  assert.match(data.error, /privacy_level/);
  assert.match(data.error, /cover_timestamp_ms/);
});

test('TikTok rejects carousels and more than one asset', async () => {
  assert.equal((await create({ type: 'carousel' })).status, 400);
  assert.equal((await create({ asset_keys: [KEY, `${OWNER}/reel/b.mp4`] })).status, 400);
});

test('TikTok-only fields on an Instagram post are refused, not silently dropped', async () => {
  const r = await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [KEY], caption: 'c', post_at: futureISO(), privacy_level: 'SELF_ONLY' }), env });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /TikTok/);
});

test('IG creation is unchanged: platform ig, no tiktok_options', async () => {
  const r = await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [KEY], caption: 'c', post_at: futureISO() }), env });
  assert.equal(r.status, 200);
  assert.equal(row('i1').platform, 'ig');
  assert.equal(row('i1').tiktok_options, null);
});

test('same account + platform + asset + post_at again returns the EXISTING id (duplicate:true), no second row', async () => {
  const at = futureISO();
  await create({ post_at: at });
  const again = await create({ id: 'p2', post_at: at });
  assert.equal(again.status, 200);
  assert.deepEqual({ id: again.data.id, duplicate: again.data.duplicate }, { id: 'p1', duplicate: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduled_posts').get().n, 1);
});

test('the guard is exact: another time, platform or asset is a different post; a FAILED post does not block a retry', async () => {
  const at = futureISO();
  await create({ post_at: at });
  assert.equal((await create({ id: 'p2', post_at: futureISO(6) })).data.duplicate, undefined);
  assert.equal((await create({ id: 'p3', post_at: at, asset_keys: [`${OWNER}/reel/z.mp4`] })).data.duplicate, undefined);
  const igSame = await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [KEY], caption: 'c', post_at: at }), env });
  assert.equal((await igSame.json()).duplicate, undefined);
  db.prepare(`UPDATE scheduled_posts SET status='failed' WHERE id='p1'`).run();
  assert.equal((await create({ id: 'p4', post_at: at })).data.duplicate, undefined);
});

// ── GET filters ─────────────────────────────────────────────────────────────
test('GET ?platform=tiktok&status=scheduled filters; TikTok rows carry their options flat', async () => {
  await create({ title: 'T' });
  await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [`${OWNER}/reel/i.mp4`], caption: 'c', post_at: futureISO() }), env });
  const list = async (qs) => (await schedule({ request: req('GET', null, `https://brandgita.com/api/schedule${qs}`), env })).json();
  assert.deepEqual((await list('')).posts.map((p) => p.id).sort(), ['i1', 'p1']);
  const tt = await list('?platform=tiktok&status=scheduled');
  assert.deepEqual(tt.posts.map((p) => p.id), ['p1']);
  assert.equal(tt.posts[0].privacy_level, 'SELF_ONLY');
  assert.equal(tt.posts[0].title, 'T');
  assert.equal(tt.posts[0].cover_timestamp_ms, 0);
  assert.equal('tiktok_options' in tt.posts[0], false);
  assert.deepEqual((await list('?platform=ig')).posts.map((p) => p.id), ['i1']);
  assert.deepEqual((await list('?status=posted')).posts, []);
});

// ── PATCH ───────────────────────────────────────────────────────────────────
const patch = async (id, b) => { const r = await scheduleId({ request: req('PATCH', b), env, params: { id } }); return { status: r.status, data: await r.json() }; };

test('PATCH changes TikTok options and merges them over what is stored', async () => {
  await create({ title: 'old', privacy_level: 'SELF_ONLY' });
  const out = await patch('p1', { privacy_level: 'PUBLIC_TO_EVERYONE', cover_timestamp_ms: 1500 });
  assert.equal(out.status, 200);
  assert.deepEqual(JSON.parse(row().tiktok_options), { privacy_level: 'PUBLIC_TO_EVERYONE', cover_timestamp_ms: 1500, title: 'old' });
  assert.equal(out.data.privacy_level, 'PUBLIC_TO_EVERYONE');
});

test('PATCH rejects bad TikTok values, and TikTok fields on an Instagram post', async () => {
  await create({});
  assert.equal((await patch('p1', { privacy_level: 'nope' })).status, 400);
  await schedule({ request: req('POST', { id: 'i1', type: 'reel', asset_keys: [`${OWNER}/reel/i.mp4`], caption: 'c', post_at: futureISO() }), env });
  const bad = await patch('i1', { privacy_level: 'SELF_ONLY' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /TikTok/);
});

test('PATCH of post_at / caption works for TikTok as before and a posted TikTok post is still immutable', async () => {
  await create({});
  assert.equal((await patch('p1', { post_at: futureISO(8), caption: 'new' })).status, 200);
  db.prepare(`UPDATE scheduled_posts SET status='posted' WHERE id='p1'`).run();
  assert.equal((await patch('p1', { privacy_level: 'SELF_ONLY' })).status, 409);
});
