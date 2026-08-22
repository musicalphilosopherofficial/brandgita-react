// Tests for project_slug on POST/GET /api/schedule
//   node --test functions/api/schedule.project.test.js
//
// Layer: TDD unit. Request handling — parsing, bounding, persisting one optional field.
//
// WHY THE FIELD EXISTS
// --------------------
// The desktop sidebar organises work as project → platform → format
// (decisions/content-project-model.md). The platform level IS the set of posts for a
// project — but scheduled_posts recorded what was sent and where, never what it came
// from. Without this column the tree could only ever show its "Not posted yet" branch,
// and a creator's published work would be invisible in the view built to show it.
//
// The tests below are mostly about it being OPTIONAL. This endpoint is live with a paying
// customer and every desktop build shipped so far omits the field; a required field would
// break them all the moment it deployed. That is the same constraint migration 0012
// recorded for `platform`, and the same mistake is available here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './schedule.js';

const USER = 'ig_user_1';

/** A D1 stub that records the INSERT binds and can replay SELECT rows. */
function fakeDB({ rows = [], onInsert = () => {} } = {}) {
  return {
    prepare(sql) {
      return {
        bind: (...args) => ({
          async first() {
            // The auth lookup: any bearer token resolves to USER.
            if (sql.includes('FROM ig_tokens')) {
              return { ig_user_id: USER, desktop_token_created_at: new Date().toISOString() };
            }
            return null;
          },
          async run() {
            if (sql.includes('INSERT INTO scheduled_posts')) onInsert({ sql, args });
            return {};
          },
          async all() {
            // Project to the SELECT list, the way D1 does. A stub that returns rows
            // verbatim cannot tell whether the query asks for a column at all — which
            // made the GET tests below pass against SQL that never selected project_slug.
            const m = /SELECT\s+([\s\S]+?)\s+FROM/i.exec(sql);
            if (!m) return { results: rows };
            const cols = m[1].split(',').map((c) => c.trim().split(/\s+/).pop());
            return {
              results: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))),
            };
          },
        }),
      };
    },
  };
}

function ctx(body, { db = fakeDB(), method = 'POST' } = {}) {
  return {
    env: { DB: db },
    request: {
      method,
      headers: { get: (k) => (k === 'Authorization' ? 'Bearer tok' : null) },
      async json() { return body; },
    },
  };
}

function validBody(over) {
  return {
    id: 'post-1',
    type: 'reel',
    asset_keys: [`${USER}/a.mp4`],
    caption: 'hello',
    post_at: new Date(Date.now() + 86400000).toISOString(),
    ...over,
  };
}

/** The value bound to project_slug, which is the LAST bind in the insert. */
function boundSlug(captured) {
  return captured.args[captured.args.length - 1];
}

// ---------------------------------------------------------------------------
// optional, because older clients cannot send it
// ---------------------------------------------------------------------------

test('a request with no project_slug still succeeds', async () => {
  // Every desktop build shipped to date. This endpoint is live with a paying customer.
  let captured;
  const res = await onRequest(ctx(validBody(), { db: fakeDB({ onInsert: (c) => { captured = c; } }) }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(boundSlug(captured), null, 'a missing slug should persist as NULL, not ""');
});

test('a project_slug is persisted when given', async () => {
  let captured;
  await onRequest(ctx(validBody({ project_slug: 'tuesday_reel' }),
    { db: fakeDB({ onInsert: (c) => { captured = c; } }) }));
  assert.equal(boundSlug(captured), 'tuesday_reel');
});

test('the column is named in the INSERT', async () => {
  // Guards the bind-order coupling above: adding a column without adding it to the SQL
  // would silently bind the slug to whatever sits last instead.
  let captured;
  await onRequest(ctx(validBody({ project_slug: 's' }),
    { db: fakeDB({ onInsert: (c) => { captured = c; } }) }));
  assert.ok(captured.sql.includes('project_slug'));
});

// ---------------------------------------------------------------------------
// bounded, because it is never validated against anything
// ---------------------------------------------------------------------------

test('a non-string project_slug is rejected', async () => {
  const res = await onRequest(ctx(validBody({ project_slug: { evil: true } })));
  assert.equal(res.status, 400);
});

test('an over-long slug is truncated, not rejected', async () => {
  // The cron reads this table every 60 seconds. A malformed client must not be able to
  // write an unbounded string into it — but a long slug is a client bug, not a reason to
  // refuse a creator's post.
  let captured;
  await onRequest(ctx(validBody({ project_slug: 'x'.repeat(5000) }),
    { db: fakeDB({ onInsert: (c) => { captured = c; } }) }));
  assert.equal(boundSlug(captured).length, 200);
});

test('a whitespace-only slug becomes NULL', async () => {
  // "   " is not a project. Storing it would create a phantom group in the sidebar tree
  // with a blank name.
  let captured;
  await onRequest(ctx(validBody({ project_slug: '   ' }),
    { db: fakeDB({ onInsert: (c) => { captured = c; } }) }));
  assert.equal(boundSlug(captured), null);
});

test('an explicitly null slug is accepted', async () => {
  const res = await onRequest(ctx(validBody({ project_slug: null })));
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// it comes back out again
// ---------------------------------------------------------------------------

test('GET returns project_slug so the client can group by it', async () => {
  // Storing it and not returning it would be the whole feature, missing its point.
  const rows = [{ id: 'p1', platform: 'ig', type: 'reel', post_at: 'x', status: 'scheduled',
                  permalink: null, error: null, caption: 'c', project_slug: 'tuesday_reel' }];
  const res = await onRequest(ctx(null, { db: fakeDB({ rows }), method: 'GET' }));
  const body = await res.json();
  assert.equal(body.posts[0].project_slug, 'tuesday_reel');
});

test('GET on rows that predate the column returns null, not a crash', async () => {
  const rows = [{ id: 'p1', platform: 'ig', type: 'reel', post_at: 'x', status: 'scheduled',
                  permalink: null, error: null, caption: 'c', project_slug: null }];
  const res = await onRequest(ctx(null, { db: fakeDB({ rows }), method: 'GET' }));
  assert.equal((await res.json()).posts[0].project_slug, null);
});
