// Posted media is deleted from R2 7 days after it posts — and ONLY posted media.
// Run: node --test shared/media-retention.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgePostedMedia, MEDIA_RETENTION_DAYS } from './media-retention.js';

const DAY = 86400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

function makeEnv(posts, { failDelete = () => false } = {}) {
  const rows = JSON.parse(JSON.stringify(posts));
  const deleted = [];
  return {
    rows, deleted,
    DB: {
      prepare(sql) {
        return {
          bind: (...args) => ({
            async all() {
              assert.ok(sql.includes(`status = 'posted'`), 'must only ever select posted rows');
              const [cutoff] = args;
              return { results: rows.filter((r) => r.status === 'posted' && !r.media_purged_at && r.post_at <= cutoff) };
            },
            async run() {
              const [at, id] = args;
              const r = rows.find((x) => x.id === id);
              if (r) r.media_purged_at = at;
              return { meta: { changes: r ? 1 : 0 } };
            },
          }),
        };
      },
    },
    SCHEDULE_BUCKET: {
      async delete(key) { if (failDelete(key)) throw new Error('r2 down'); deleted.push(key); },
    },
  };
}
const row = (over) => ({ id: 'a', status: 'posted', post_at: iso(-8), asset_keys: JSON.stringify(['u/reel/a.mp4']), cover_key: 'u/cover/a.jpg', media_purged_at: null, ...over });

test('retention is 7 days', () => assert.equal(MEDIA_RETENTION_DAYS, 7));

test('a post older than 7 days loses its video AND cover, and is marked purged', async () => {
  const env = makeEnv([row()]);
  const out = await purgePostedMedia(env);
  assert.deepEqual(env.deleted.sort(), ['u/cover/a.jpg', 'u/reel/a.mp4']);
  assert.ok(env.rows[0].media_purged_at);
  assert.equal(out.purged, 1);
});

test('a post under 7 days old keeps its media', async () => {
  const env = makeEnv([row({ post_at: iso(-6) })]);
  await purgePostedMedia(env);
  assert.deepEqual(env.deleted, []);
});

test('failed, scheduled and posting posts are NEVER purged, however old', async () => {
  const env = makeEnv(['failed', 'scheduled', 'posting', 'held_entitlement'].map((s, i) => row({ id: `x${i}`, status: s, post_at: iso(-30) })));
  await purgePostedMedia(env);
  assert.deepEqual(env.deleted, []);
});

test('already-purged rows are skipped', async () => {
  const env = makeEnv([row({ media_purged_at: iso(-1) })]);
  await purgePostedMedia(env);
  assert.deepEqual(env.deleted, []);
});

test('if any R2 delete fails the row is NOT marked purged, so the next run retries', async () => {
  const env = makeEnv([row()], { failDelete: (k) => k.endsWith('.jpg') });
  const out = await purgePostedMedia(env);
  assert.equal(env.rows[0].media_purged_at, null);
  assert.equal(out.failed, 1);
});

test('one bad row does not block the others; malformed asset_keys is tolerated', async () => {
  const env = makeEnv([row({ id: 'bad', asset_keys: '{not json', cover_key: null }), row({ id: 'good' })]);
  await purgePostedMedia(env);
  assert.ok(env.rows.find((r) => r.id === 'good').media_purged_at);
});

test('a row with no media at all is simply marked purged', async () => {
  const env = makeEnv([row({ asset_keys: '[]', cover_key: null })]);
  await purgePostedMedia(env);
  assert.ok(env.rows[0].media_purged_at);
});
