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
function makeEnv({ post = null } = {}) {
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
    },
  };
  return { env, bucketCalls, updates };
}

function ctx(body, { id = 'post-1', post = null, auth = 'Bearer tok' } = {}) {
  const { env, bucketCalls, updates } = makeEnv({ post });
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

test('post_at beyond the 45-day horizon → 400', async () => {
  const { context, updates } = ctx({ post_at: futureISO(46) }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /45 days/);
  assert.equal(updates.length, 0);
});

test('post_at at day 40 (within 45-day horizon) → ok', async () => {
  const at = futureISO(40);
  const { context, updates } = ctx({ post_at: at }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.post_at, at);
  assert.equal(updates.length, 1);
});

test('body containing asset_keys → 400, row unchanged', async () => {
  const { context, updates } = ctx(
    { post_at: futureISO(2), asset_keys: ['x/a.mp4'] },
    { post: scheduledPost() }
  );
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /asset_keys/);
  assert.equal(updates.length, 0);
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

test('post_at missing → 400', async () => {
  const { context } = ctx({ caption: 'only caption' }, { post: scheduledPost() });
  const res = await onRequest(context);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.match(data.error, /post_at is required/);
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
