// Tests for PATCH /api/schedule/{id} — run with:
//   node --test functions/api/schedule.patch.test.js
// No deps: Node's built-in test runner. Fake D1 + a fake R2 bucket that records
// every call (the zero-R2-touch guarantee is the regression that matters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './schedule/[id].js';

const OWNER = 'ig-owner-1';

// Fake D1: dispatches on the SQL text. Auth's ig_tokens lookup always resolves to
// OWNER with a fresh token; the scheduled_posts SELECT returns whatever `post` we
// seed; UPDATEs are recorded into `updates`.
function makeEnv({ post = null, existing = [] } = {}) {
  const bucketCalls = [];
  const updates = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('ig_tokens')) {
                  return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
                }
                if (sql.includes('scheduled_posts')) {
                  return post; // may be null → "not found"
                }
                return null;
              },
              async run() {
                if (sql.includes('UPDATE')) updates.push({ sql, args });
                return {};
              },
            };
          },
        };
      },
    },
    // Any call here is a bug — PATCH must never touch storage.
    SCHEDULE_BUCKET: {
      delete: async (key) => { bucketCalls.push(key); },
      put: async (key) => { bucketCalls.push(key); },
      // head() is a READ (does the replacement already exist in R2?), so it is not recorded as a storage write.
      head: async (key) => (existing.includes(key) ? { key } : null),
    },
  };
  return { env, bucketCalls, updates };
}

function ctx(body, { id = 'post-1', post = null, auth = 'Bearer tok', existing = [] } = {}) {
  const { env, bucketCalls, updates } = makeEnv({ post, existing });
  const context = {
    env,
    params: { id },
    request: {
      method: 'PATCH',
      headers: { get: (k) => (k === 'Authorization' ? auth : null) },
      json: async () => body,
    },
  };
  return { context, bucketCalls, updates };
}

const scheduledPost = (over = {}) => ({
  id: 'post-1',
  ig_user_id: OWNER,
  status: 'scheduled',
  caption: 'original caption',
  platform: 'ig',
  type: 'reel',
  asset_keys: JSON.stringify([`${OWNER}/reel.mp4`]),
  cover_key: `${OWNER}/cover.jpg`,
  ...over,
});

const futureISO = (days = 5) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

test('moves post_at, returns ok:true, and makes ZERO bucket calls', async () => {
  const at = futureISO(5);
  const { context, bucketCalls, updates } = ctx({ post_at: at }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.id, 'post-1');
  assert.equal(data.post_at, at);
  assert.equal(data.caption, 'original caption'); // unchanged caption echoed back
  assert.equal(bucketCalls.length, 0, 'PATCH must never touch R2');
  assert.equal(updates.length, 1);
  assert.ok(!updates[0].sql.includes('caption'), 'no caption column when caption omitted');
});

test('patches caption alongside post_at', async () => {
  const at = futureISO(3);
  const { context, updates } = ctx(
    { post_at: at, caption: 'brand new caption' },
    { post: scheduledPost() }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.caption, 'brand new caption');
  assert.ok(updates[0].sql.includes('caption'), 'caption column updated when supplied');
});

test("another user's post → 404, body does not reveal it exists", async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2) },
    { post: scheduledPost({ ig_user_id: 'someone-else' }) }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 404);
  assert.equal(data.ok, false);
  assert.equal(data.error, 'Post not found'); // same as genuinely-missing
  assert.equal(updates.length, 0, 'row unchanged');
});

test("status 'posted' → 409, row unchanged", async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2) },
    { post: scheduledPost({ status: 'posted' }) }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 409);
  assert.match(data.error, /already posted/);
  assert.equal(updates.length, 0);
});

test("status 'posting' (mid-flight) → 409", async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2) },
    { post: scheduledPost({ status: 'posting' }) }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 409);
  assert.match(data.error, /already posting/);
  assert.equal(updates.length, 0);
});

test('post_at in the past → 400', async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { context, updates } = ctx({ post_at: past }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /future/);
  assert.equal(updates.length, 0);
});

test('post_at beyond the 30-day horizon → 400', async () => {
  const { context, updates } = ctx({ post_at: futureISO(31) }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /30 days/);
  assert.equal(updates.length, 0);
});

test('post_at at day 25 (within 30-day horizon) → ok', async () => {
  const at = futureISO(25);
  const { context, updates } = ctx({ post_at: at }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.post_at, at);
  assert.equal(updates.length, 1);
});

// Audit 2026-10-02 (founder: "all things that can be updated via api must be added"): asset_keys and cover_key are now
// patchable, under the SAME checks a new post gets (account prefix, the platform contract, the object already in R2). The old
// 'body containing asset_keys → 400' case pinned the narrow v1 contract; it is replaced by the cases below.
test('patches cover_key: checks the new cover exists, updates the row, then deletes the replaced cover', async () => {
  const { context, bucketCalls, updates } = ctx(
    { cover_key: `${OWNER}/cover-v2.jpg` },
    { post: scheduledPost(), existing: [`${OWNER}/cover-v2.jpg`] }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.cover_key, `${OWNER}/cover-v2.jpg`);
  assert.ok(updates[0].sql.includes('cover_key'));
  assert.deepEqual(bucketCalls, [`${OWNER}/cover.jpg`], 'only the replaced cover is deleted, the video stays');
});

test("cover_key outside the caller's account → 403, row and storage unchanged", async () => {
  const { context, bucketCalls, updates } = ctx(
    { cover_key: 'someone-else/cover.jpg' },
    { post: scheduledPost(), existing: ['someone-else/cover.jpg'] }
  );
  const res = await onRequest(context);
  assert.equal(res.status, 403);
  assert.equal(updates.length, 0);
  assert.equal(bucketCalls.length, 0);
});

test('cover_key not yet uploaded → 400, nothing deleted', async () => {
  const { context, bucketCalls, updates } = ctx({ cover_key: `${OWNER}/never-uploaded.jpg` }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.match(data.error, /not uploaded/);
  assert.equal(updates.length, 0);
  assert.equal(bucketCalls.length, 0);
});

test('asset_keys swap obeys the platform contract (a reel needs exactly 1 asset)', async () => {
  const keys = [`${OWNER}/a.mp4`, `${OWNER}/b.mp4`];
  const { context, updates } = ctx({ asset_keys: keys }, { post: scheduledPost(), existing: keys });
  const res = await onRequest(context);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.match(data.error, /exactly 1 asset/);
  assert.equal(updates.length, 0);
});

test('asset_keys swap: the new video replaces the old one, which is deleted after the update', async () => {
  const { context, bucketCalls, updates } = ctx(
    { asset_keys: [`${OWNER}/reel-v2.mp4`] },
    { post: scheduledPost(), existing: [`${OWNER}/reel-v2.mp4`] }
  );
  const res = await onRequest(context);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data.asset_keys, [`${OWNER}/reel-v2.mp4`]);
  assert.ok(updates[0].sql.includes('asset_keys'));
  assert.deepEqual(bucketCalls, [`${OWNER}/reel.mp4`]);
});

test('type, platform and id stay fixed → 400', async () => {
  for (const field of ['type', 'platform', 'id', 'ig_user_id']) {
    const { context, updates } = ctx({ [field]: 'x' }, { post: scheduledPost() });
    const res = await onRequest(context);
    const data = await res.json();
    assert.equal(res.status, 400, field);
    assert.match(data.error, new RegExp(field));
    assert.equal(updates.length, 0);
  }
});

test('unknown key in body → 400', async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2), wat: true },
    { post: scheduledPost() }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /wat/);
  assert.equal(updates.length, 0);
});

test('caption over 2200 chars → 400', async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2), caption: 'x'.repeat(2201) },
    { post: scheduledPost() }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /2200/);
  assert.equal(updates.length, 0);
});

// Audit 2026-10-02: post_at is no longer required (a cover or caption can change without moving the post); an EMPTY patch is
// still a 400, so a client that sends nothing hears about it.
test('caption alone, without post_at → ok, post_at untouched', async () => {
  const { context, updates } = ctx({ caption: 'only caption' }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.caption, 'only caption');
  assert.ok(!updates[0].sql.includes('post_at'));
});

test('empty patch → 400', async () => {
  const { context } = ctx({}, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.match(data.error, /nothing to update/);
});

test('non-existent id → 404', async () => {
  const { context, updates } = ctx({ post_at: futureISO(2) }, { post: null });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 404);
  assert.equal(data.error, 'Post not found');
  assert.equal(updates.length, 0);
});

test('missing bearer token → 401', async () => {
  const { context } = ctx({ post_at: futureISO(2) }, { post: scheduledPost(), auth: '' });
  const res = await onRequest(context);
  assert.equal(res.status, 401);
});
