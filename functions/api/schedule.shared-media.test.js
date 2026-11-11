// Handler wiring for shared media: DELETE / PATCH must not remove an R2 object another post uses,
// and /api/upload-url returns the rendition plan when asked. Run: node --test functions/api/schedule.shared-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as scheduleId } from './schedule/[id].js';
import { onRequest as uploadUrl } from './upload-url.js';

const OWNER = 'ig-owner-1';
const KEY = `${OWNER}/reel/a.mp4`;
const futureISO = (d = 5) => new Date(Date.now() + d * 864e5).toISOString();

function makeEnv({ post, sharedElsewhere }) {
  const bucketDeletes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('ig_tokens')) return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
                // The reference lookup (shared/media-refs.js): a row = "another post still uses this key".
                if (sql.includes('instr(')) return sharedElsewhere ? { n: 1 } : null;
                if (sql.includes('scheduled_posts')) return post;
                return null;
              },
              async run() { return {}; },
            };
          },
        };
      },
    },
    SCHEDULE_BUCKET: {
      head: async (k) => ({ key: k }),
      delete: async (k) => { bucketDeletes.push(k); },
    },
  };
  return { env, bucketDeletes };
}
const req = (method, body) => ({ method, url: 'https://brandgita.com/api/x', headers: { get: (k) => (k === 'Authorization' ? 'Bearer tok' : null) }, json: async () => body });
const scheduled = (over = {}) => ({ id: 'post-1', ig_user_id: OWNER, status: 'scheduled', caption: 'c', post_at: futureISO(), platform: 'ig', type: 'reel', asset_keys: JSON.stringify([KEY]), cover_key: null, trial_strategy: null, ...over });

test('DELETE: the post\'s clip is removed from R2 when nothing else uses it', async () => {
  const { env, bucketDeletes } = makeEnv({ post: scheduled(), sharedElsewhere: false });
  const res = await scheduleId({ request: req('DELETE'), env, params: { id: 'post-1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(bucketDeletes, [KEY]);
});

test('DELETE: the clip STAYS in R2 when another scheduled post (another platform) still uses it', async () => {
  const { env, bucketDeletes } = makeEnv({ post: scheduled(), sharedElsewhere: true });
  const res = await scheduleId({ request: req('DELETE'), env, params: { id: 'post-1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(bucketDeletes, []);
});

test('PATCH asset swap: the replaced clip is kept while another post uses it', async () => {
  const newKey = `${OWNER}/reel/b.mp4`;
  const { env, bucketDeletes } = makeEnv({ post: scheduled(), sharedElsewhere: true });
  const res = await scheduleId({ request: req('PATCH', { asset_keys: [newKey] }), env, params: { id: 'post-1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(bucketDeletes, []);
});

test('PATCH asset swap: the replaced clip is deleted when nothing else uses it', async () => {
  const newKey = `${OWNER}/reel/b.mp4`;
  const { env, bucketDeletes } = makeEnv({ post: scheduled(), sharedElsewhere: false });
  await scheduleId({ request: req('PATCH', { asset_keys: [newKey] }), env, params: { id: 'post-1' } });
  assert.deepEqual(bucketDeletes, [KEY]);
});

// ── upload-url ────────────────────────────────────────────────────────────────
const landscape = { width: 1920, height: 1080, durationSec: 60, bytes: 20e6 };

test('upload-url: without clip/targets the response is unchanged (no plan)', async () => {
  const { env } = makeEnv({ post: null });
  const res = await uploadUrl({ request: req('POST', { keys: [KEY] }), env });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal('plan' in data, false);
});

test('upload-url: with clip + targets it returns the rendition plan', async () => {
  const { env } = makeEnv({ post: null });
  const res = await uploadUrl({ request: req('POST', { keys: [KEY], clip: landscape, targets: [{ platform: 'ig', kind: 'reel' }, { platform: 'yt', kind: 'video' }] }), env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.plan.renditions.length, 2);
  assert.equal(data.uploads.length, 1, 'uploads still mirror the keys the caller asked for');
});

test('upload-url: a plan with problems is a 400 that lists them', async () => {
  const { env } = makeEnv({ post: null });
  const res = await uploadUrl({ request: req('POST', { keys: [KEY], clip: { ...landscape, durationSec: 700 }, targets: [{ platform: 'tt', kind: 'video' }] }), env });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.match(data.error, /TikTok/);
});

test('upload-url: targets without a clip is a 400, not a silently skipped plan', async () => {
  const { env } = makeEnv({ post: null });
  const res = await uploadUrl({ request: req('POST', { keys: [KEY], targets: [{ platform: 'ig', kind: 'reel' }] }), env });
  assert.equal(res.status, 400);
});
