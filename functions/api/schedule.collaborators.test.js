// collaborators through POST / PATCH / GET /api/schedule, against real SQLite with all migrations applied.
// Run: node --test functions/api/schedule.collaborators.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as schedule } from './schedule.js';
import { onRequest as scheduleId } from './schedule/[id].js';

const OWNER = 'ig-owner-1';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
let db; let env;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    try { db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; }
  }
  const real = (sql) => ({
    bind: (...a) => ({
      async first() {
        // Auth is not under test: answer the token lookup directly.
        if (sql.includes('ig_tokens')) return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
        return db.prepare(sql).get(...a) ?? null;
      },
      async all() { return { results: db.prepare(sql).all(...a) }; },
      async run() { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } }; },
    }),
  });
  env = { DB: { prepare: real }, SCHEDULE_BUCKET: { head: async (key) => ({ key }), delete: async () => {} } };
});

const AT = () => new Date(Date.now() + 5 * 864e5).toISOString();
const req = (method, body, url = 'https://x/api/schedule') => ({ method, url, headers: { get: (k) => (k === 'Authorization' ? 'Bearer t' : null) }, json: async () => body });
const reel = (over = {}) => ({ id: 'p1', type: 'reel', asset_keys: [`${OWNER}/reel/a.mp4`], caption: 'cap', post_at: AT(), ...over });
const create = async (over) => { const res = await schedule({ request: req('POST', reel(over)), env }); return { res, data: await res.json() }; };
const patch = async (id, body) => { const res = await scheduleId({ request: req('PATCH', body), env, params: { id } }); return { res, data: await res.json() }; };
const list = async () => (await (await schedule({ request: req('GET'), env })).json()).posts;
const row = (id = 'p1') => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);

test('create with collaborators: stored normalised and returned by GET as a list', async () => {
  assert.equal((await create({ collaborators: ['@geoff', 'sam'] })).res.status, 200);
  assert.deepEqual(JSON.parse(row().collaborators), ['geoff', 'sam']);
  assert.deepEqual((await list())[0].collaborators, ['geoff', 'sam']);
});
test('create without: column is NULL and GET says null', async () => {
  await create();
  assert.equal(row().collaborators, null);
  assert.equal((await list())[0].collaborators, null);
});
test('a carousel takes them too', async () => {
  const r = await create({ type: 'carousel', asset_keys: [`${OWNER}/carousel/a.jpg`, `${OWNER}/carousel/b.jpg`], collaborators: ['a'] });
  assert.equal(r.res.status, 200);
});
test('4 names, a bad name, and a story are 400s; nothing is stored', async () => {
  assert.match((await create({ collaborators: ['a', 'b', 'c', 'd'] })).data.error, /at most 3/);
  assert.match((await create({ collaborators: ['bad name'] })).data.error, /collaborators\[0\]/);
  const s = await create({ type: 'story', asset_keys: [`${OWNER}/story/a.jpg`], caption: '', collaborators: ['a'] });
  assert.equal(s.res.status, 400);
  assert.match(s.data.error, /collaborators only apply to: reel, carousel/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduled_posts').get().n, 0);
});
test('PATCH adds, changes and removes them without touching time, caption or media', async () => {
  await create();
  const before = row();
  const added = await patch('p1', { collaborators: ['@geoff'] });
  assert.equal(added.res.status, 200);
  assert.deepEqual(added.data.collaborators, ['geoff']);
  for (const k of ['post_at', 'caption', 'asset_keys', 'cover_key', 'status']) assert.equal(row()[k], before[k], k);
  assert.deepEqual((await patch('p1', { collaborators: ['sam'] })).data.collaborators, ['sam']);
  assert.equal((await patch('p1', { collaborators: [] })).data.collaborators, null);
  assert.equal(row().collaborators, null);
});
test('PATCH of something else leaves collaborators alone and still echoes them', async () => {
  await create({ collaborators: ['geoff'] });
  const r = await patch('p1', { caption: 'new' });
  assert.deepEqual(r.data.collaborators, ['geoff']);
  assert.deepEqual(JSON.parse(row().collaborators), ['geoff']);
});
test('PATCH is refused once posting or posted, and on a story', async () => {
  await create();
  for (const status of ['posting', 'posted', 'failed']) {
    db.prepare('UPDATE scheduled_posts SET status = ?').run(status);
    assert.equal((await patch('p1', { collaborators: ['a'] })).res.status, 409, status);
  }
  db.prepare("UPDATE scheduled_posts SET status = 'scheduled', type = 'story', caption = ''").run();
  assert.equal((await patch('p1', { collaborators: ['a'] })).res.status, 400);
  assert.equal(row().collaborators, null);
});
