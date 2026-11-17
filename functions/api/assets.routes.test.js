// Tagged uploads and the assets list, through the real route handlers over real SQLite.
// Run: node --test functions/api/assets.routes.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as uploadUrl } from './upload-url.js';
import { onRequest as multipart } from './media-upload/[key].js';
import { onRequest as mediaPut } from './media/[key].js';
import { onRequest as assets } from './assets.js';

const OWNER = '123456';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
let db; let env; let stored;

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
  stored = new Set();
  env = {
    API_SECRET: 's', DB: d1(db),
    SCHEDULE_BUCKET: {
      head: async (k) => (stored.has(k) ? { key: k, size: 10 } : null),
      put: async (k) => { stored.add(k); },
      createMultipartUpload: async () => ({ uploadId: 'u1' }),
      resumeMultipartUpload: (k) => ({ complete: async () => { stored.add(k); return { size: 10 }; } }),
      delete: async (k) => { stored.delete(k); },
    },
  };
});

const hdrs = (extra = {}) => ({ get: (k) => ({ Authorization: 'Bearer tok', 'Content-Type': 'video/mp4', 'Content-Length': '3', ...extra })[k] ?? null });
const req = (method, body, url = 'https://brandgita.com/api/x', extra) => ({ method, url, headers: hdrs(extra), json: async () => body, body: new Blob(['abc']).stream(), arrayBuffer: async () => new ArrayBuffer(3) });
const meta = (over = {}) => ({ piece: 'dawn', targets: ['tiktok', 'ig'], aspect: '9:16', tags: ['launch'], source_path_hash: 'h1', ...over });
const key = (n) => `${OWNER}/reel/${n}.mp4`;
const ask = (body) => uploadUrl({ request: req('POST', body), env }).then(async (r) => ({ status: r.status, data: await r.json() }));

test('old request shape (no metadata) is unchanged and records nothing', async () => {
  const { status, data } = await ask({ keys: [key('a')] });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(data), ['ok', 'uploads']);
  assert.equal(data.uploads[0].key, key('a'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 0);
});

test('metadata is stored on the asset row and echoed back', async () => {
  const { status, data } = await ask({ keys: [key('a')], metadata: meta() });
  assert.equal(status, 200);
  assert.equal(data.asset.existing, false);
  assert.deepEqual(data.asset.metadata.targets, ['tt', 'ig']);
  assert.equal(db.prepare('SELECT piece FROM assets').get().piece, 'dawn');
});

test('bad metadata is a 400 naming the problems; an aspect/target clash is caught', async () => {
  const bad = await ask({ keys: [key('a')], metadata: meta({ targets: ['tiktok'], aspect: '4:5' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /TikTok/);
  const many = await ask({ keys: [key('a'), key('b')], metadata: meta() });
  assert.equal(many.status, 400);
  assert.match(many.data.error, /one key/);
});

test('upload once: after the PUT the same source_path_hash + aspect returns the existing key and flags existing', async () => {
  await ask({ keys: [key('a')], metadata: meta() });
  const put = await mediaPut({ request: req('PUT', null), env, params: { key: encodeURIComponent(key('a')) } });
  assert.equal(put.status, 200);
  const again = await ask({ keys: [key('b')], metadata: meta() });
  assert.equal(again.data.asset.existing, true);
  assert.equal(again.data.uploads[0].key, key('a'));
  assert.equal(again.data.uploads[0].existing, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 1);
});

test('multipart create: metadata stored; a duplicate answers existing:true with NO upload_id', async () => {
  const create = (k, m) => multipart({ request: req('POST', { content_type: 'video/mp4', size: 10, metadata: m }, 'https://brandgita.com/api/media-upload/x?action=create'), env, params: { key: encodeURIComponent(k) } }).then((r) => r.json());
  const first = await create(key('a'), meta());
  assert.equal(first.ok, true);
  assert.equal(first.upload_id, 'u1');
  const done = await multipart({ request: req('POST', { upload_id: 'u1', size: 10, parts: [{ part: 1, etag: 'e' }] }, 'https://brandgita.com/api/media-upload/x?action=complete'), env, params: { key: encodeURIComponent(key('a')) } });
  assert.equal((await done.json()).ok, true);
  const dup = await create(key('b'), meta());
  assert.equal(dup.existing, true);
  assert.equal(dup.key, key('a'));
  assert.equal('upload_id' in dup, false);
});

test('multipart create without metadata behaves exactly as before', async () => {
  const r = await multipart({ request: req('POST', { content_type: 'video/mp4', size: 10 }, 'https://brandgita.com/api/media-upload/x?action=create'), env, params: { key: encodeURIComponent(key('a')) } });
  assert.deepEqual(Object.keys(await r.json()), ['ok', 'upload_id', 'part_size']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 0);
});

test('GET /api/assets lists what is uploaded, filtered by tag; pending reservations are hidden', async () => {
  await ask({ keys: [key('a')], metadata: meta() });
  await mediaPut({ request: req('PUT', null), env, params: { key: encodeURIComponent(key('a')) } });
  await ask({ keys: [key('p')], metadata: meta({ source_path_hash: 'h2', tags: ['other'] }) }); // never uploaded
  const list = async (qs) => (await assets({ request: req('GET', null, `https://brandgita.com/api/assets${qs}`), env })).json();
  assert.deepEqual((await list('')).assets.map((a) => a.key), [key('a')]);
  assert.deepEqual((await list('?tag=launch')).assets.map((a) => a.key), [key('a')]);
  assert.deepEqual((await list('?tag=nope')).assets, []);
  assert.deepEqual((await list('?target=tiktok')).assets.map((a) => a.key), [key('a')]);
});

test('GET /api/assets: bad limit is a 400, other methods 405', async () => {
  const bad = await assets({ request: req('GET', null, 'https://brandgita.com/api/assets?limit=-1'), env });
  assert.equal(bad.status, 400);
  assert.equal((await assets({ request: req('POST', {}), env })).status, 405);
});
