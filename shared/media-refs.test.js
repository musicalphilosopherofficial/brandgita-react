// A stored clip may be referenced by several scheduled posts (one upload, many platforms). Deleting
// it when ONE post goes away would break every other post still waiting to publish it.
// Run: node --test shared/media-refs.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deleteUnreferencedMedia } from './media-refs.js';
import { purgePostedMedia } from './media-retention.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
let db; let env; let deleted;

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
const seed = (id, keys, over = {}) => {
  const row = { id, ig_user_id: 'ig1', platform: 'ig', type: 'reel', asset_keys: JSON.stringify(keys), caption: 'c',
    post_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'scheduled', retry_count: 0, ...over };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO scheduled_posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};

beforeEach(() => {
  db = freshDb();
  deleted = [];
  env = { DB: d1(db), SCHEDULE_BUCKET: { delete: async (k) => { deleted.push(k); } } };
});

test('a key no other post references is deleted', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  const out = await deleteUnreferencedMedia(env, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, ['ig1/reel/x.mp4']);
  assert.deepEqual(out.kept, []);
});

test('a key another post still lists in asset_keys is KEPT', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  seed('b', ['ig1/reel/x.mp4'], { platform: 'tt' });
  const out = await deleteUnreferencedMedia(env, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, []);
  assert.deepEqual(out.kept, ['ig1/reel/x.mp4']);
});

test('a key another post uses as its cover is KEPT', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  seed('b', ['ig1/reel/y.mp4'], { cover_key: 'ig1/cover/c.jpg' });
  await deleteUnreferencedMedia(env, ['ig1/cover/c.jpg'], { excludePostId: 'a' });
  assert.deepEqual(deleted, []);
});

test('a key shared only with an already-purged post is deleted (that post no longer needs it)', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  seed('b', ['ig1/reel/x.mp4'], { status: 'posted', media_purged_at: new Date().toISOString() });
  await deleteUnreferencedMedia(env, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, ['ig1/reel/x.mp4']);
});

test('a key whose name is a PREFIX of another post\'s key is not mistaken for it', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  seed('b', ['ig1/reel/x.mp4.bak.mp4']);
  await deleteUnreferencedMedia(env, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, ['ig1/reel/x.mp4'], 'quoted match: "x.mp4" is not inside "x.mp4.bak.mp4"');
});

test('SQL wildcards in a key are literal (underscore must not match any character)', async () => {
  seed('a', ['ig1/reel/a_b.mp4']);
  seed('b', ['ig1/reel/aXb.mp4']);
  await deleteUnreferencedMedia(env, ['ig1/reel/a_b.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, ['ig1/reel/a_b.mp4']);
});

test('if the reference lookup fails, the key is KEPT (an orphan costs pennies; a broken post costs a creator)', async () => {
  const broken = { ...env, DB: { prepare() { throw new Error('d1 down'); } } };
  const out = await deleteUnreferencedMedia(broken, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(deleted, []);
  assert.deepEqual(out.kept, ['ig1/reel/x.mp4']);
  assert.equal(out.failed.length, 0);
});

test('an R2 delete failure is reported as failed, not swallowed', async () => {
  seed('a', ['ig1/reel/x.mp4']);
  const bad = { ...env, SCHEDULE_BUCKET: { delete: async () => { throw new Error('r2 down'); } } };
  const out = await deleteUnreferencedMedia(bad, ['ig1/reel/x.mp4'], { excludePostId: 'a' });
  assert.deepEqual(out.failed, ['ig1/reel/x.mp4']);
});

// ── retention: the 7-day purge must respect sharing too ──
const longAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

test('retention: a posted post\'s shared clip survives while another post still needs it, and is marked purged anyway', async () => {
  seed('a', ['ig1/reel/x.mp4'], { status: 'posted', post_at: longAgo });
  seed('b', ['ig1/reel/x.mp4'], { platform: 'tt', status: 'scheduled' });
  const out = await purgePostedMedia(env);
  assert.deepEqual(deleted, []);
  assert.equal(out.purged, 1);
  assert.ok(db.prepare(`SELECT media_purged_at FROM scheduled_posts WHERE id='a'`).get().media_purged_at);
});

test('retention: once the last referencing post purges, the clip is finally deleted', async () => {
  seed('a', ['ig1/reel/x.mp4'], { status: 'posted', post_at: longAgo });
  seed('b', ['ig1/reel/x.mp4'], { platform: 'tt', status: 'posted', post_at: longAgo });
  await purgePostedMedia(env);
  assert.deepEqual(deleted, ['ig1/reel/x.mp4'], 'deleted exactly once, by whichever purge ran last');
});
