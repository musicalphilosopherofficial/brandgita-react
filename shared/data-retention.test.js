/**
 * Cloud data retention after a subscription lapses — the founder's 15-day grace period
 * (2026-09-19), and what gets purged once it expires. See data-retention.js's own header
 * for the full rule and why each table is or isn't in scope.
 *
 * Written before data-retention.js exists, per CLAUDE.md's BDD-first rule: this is a real
 * deletion path touching four tables and R2, not a one-off script, so it gets a proper RED
 * pass first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRACE_DAYS, findLapsedMemberships, purgeMembership, runDataRetentionPurge } from './data-retention.js';

const DAY = 24 * 3600_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * Fake D1 + R2 covering exactly the statements data-retention.js issues. Mirrors the SQL
 * text (not just intent) for the same reason entitlement-hold.test.js's fake does: a fake
 * that ignored the WHERE clause would stay green even if production dropped a predicate.
 */
function makeEnv({ memberships = {}, tokens = {}, posts = {}, kits = {} } = {}) {
  const state = {
    memberships: JSON.parse(JSON.stringify(memberships)),
    tokens: JSON.parse(JSON.stringify(tokens)),
    posts: JSON.parse(JSON.stringify(posts)),
    kits: JSON.parse(JSON.stringify(kits)),
  };
  const r2Deleted = [];
  const r2Fail = new Set(); // keys that should throw on delete, to test error isolation

  function tokensFor(membershipId) {
    return Object.values(state.tokens).filter((t) => t.whop_membership_id === membershipId);
  }

  const env = {
    DB: {
      prepare(sql) {
        const bound = (args) => ({
          async all() {
            if (sql.includes('FROM whop_memberships') && sql.includes('SELECT membership_id')) {
              const [modifier] = args;
              const days = Number(modifier.match(/-(\d+) days/)[1]);
              const cutoff = Date.now() - days * DAY;
              const rows = Object.entries(state.memberships)
                .filter(([, m]) => m.status === 'inactive')
                .filter(([, m]) => Date.parse(m.updated_at) <= cutoff)
                .filter(([, m]) => m.purged_at == null)
                .map(([membership_id]) => ({ membership_id }));
              return { results: rows };
            }
            if (sql.includes('SELECT ig_user_id FROM ig_tokens')) {
              const [membershipId] = args;
              return { results: tokensFor(membershipId).map((t) => ({ ig_user_id: t.ig_user_id })) };
            }
            if (sql.includes('SELECT id, asset_keys, cover_key FROM scheduled_posts')) {
              const [igUserId] = args;
              const rows = Object.values(state.posts).filter(
                (p) => p.ig_user_id === igUserId && (p.status === 'held_entitlement' || p.status === 'missed')
              );
              return { results: rows.map(({ id, asset_keys, cover_key }) => ({ id, asset_keys, cover_key })) };
            }
            throw new Error(`fake D1: unhandled .all() SQL: ${sql}`);
          },
          async run() {
            if (sql.startsWith('DELETE FROM scheduled_posts')) {
              const [igUserId] = args;
              let changes = 0;
              for (const [id, p] of Object.entries(state.posts)) {
                if (p.ig_user_id === igUserId && (p.status === 'held_entitlement' || p.status === 'missed')) {
                  delete state.posts[id];
                  changes += 1;
                }
              }
              return { meta: { changes } };
            }
            if (sql.startsWith('DELETE FROM ig_tokens')) {
              const [membershipId] = args;
              let changes = 0;
              for (const [id, t] of Object.entries(state.tokens)) {
                if (t.whop_membership_id === membershipId) { delete state.tokens[id]; changes += 1; }
              }
              return { meta: { changes } };
            }
            if (sql.startsWith('DELETE FROM brand_kits')) {
              const [membershipId] = args;
              let changes = 0;
              for (const [id, k] of Object.entries(state.kits)) {
                if (k.membership_id === membershipId) { delete state.kits[id]; changes += 1; }
              }
              return { meta: { changes } };
            }
            if (sql.startsWith('UPDATE whop_memberships SET email')) {
              const [membershipId] = args;
              const m = state.memberships[membershipId];
              if (m) { m.email = null; m.purged_at = new Date().toISOString(); }
              return { meta: { changes: m ? 1 : 0 } };
            }
            throw new Error(`fake D1: unhandled .run() SQL: ${sql}`);
          },
        });
        return Object.assign(bound([]), { bind: (...args) => bound(args) });
      },
    },
    SCHEDULE_BUCKET: {
      async delete(key) {
        if (r2Fail.has(key)) throw new Error(`simulated R2 failure for ${key}`);
        r2Deleted.push(key);
      },
    },
  };

  return { env, state, r2Deleted, r2Fail };
}

// ---------------------------------------------------------------------------
// findLapsedMemberships
// ---------------------------------------------------------------------------

test('an active membership is never selected for purge', async () => {
  const { env } = makeEnv({
    memberships: { m1: { status: 'active', updated_at: iso(Date.now() - 30 * DAY), purged_at: null } },
  });
  assert.deepEqual(await findLapsedMemberships(env), []);
});

test('an inactive membership still inside the grace window is not selected', async () => {
  const { env } = makeEnv({
    memberships: { m1: { status: 'inactive', updated_at: iso(Date.now() - (GRACE_DAYS - 1) * DAY), purged_at: null } },
  });
  assert.deepEqual(await findLapsedMemberships(env), []);
});

test('the grace boundary is inclusive — exactly 15 days lapsed is selected', async () => {
  const { env } = makeEnv({
    memberships: { m1: { status: 'inactive', updated_at: iso(Date.now() - GRACE_DAYS * DAY), purged_at: null } },
  });
  assert.deepEqual(await findLapsedMemberships(env), ['m1']);
});

test('a membership already purged is never selected again', async () => {
  const { env } = makeEnv({
    memberships: {
      m1: { status: 'inactive', updated_at: iso(Date.now() - 40 * DAY), purged_at: iso(Date.now() - 10 * DAY) },
    },
  });
  assert.deepEqual(await findLapsedMemberships(env), []);
});

test('a re-activated-then-re-lapsed membership is judged from its latest transition', async () => {
  // updated_at reflects the most recent status write, whatever it was — a member who
  // cancelled, resubscribed, and cancelled again 2 days ago must not be purged yet.
  const { env } = makeEnv({
    memberships: { m1: { status: 'inactive', updated_at: iso(Date.now() - 2 * DAY), purged_at: null } },
  });
  assert.deepEqual(await findLapsedMemberships(env), []);
});

// ---------------------------------------------------------------------------
// purgeMembership
// ---------------------------------------------------------------------------

test('purge deletes the ig_tokens row for the lapsed membership', async () => {
  const { env, state } = makeEnv({
    tokens: { 'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1', access_token: 'secret' } },
  });
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.igTokens, 1);
  assert.equal(state.tokens['ig-1'], undefined);
});

test('purge never touches another membership\'s ig_tokens row', async () => {
  const { env, state } = makeEnv({
    tokens: {
      'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1', access_token: 'a' },
      'ig-2': { ig_user_id: 'ig-2', whop_membership_id: 'm2', access_token: 'b' },
    },
  });
  await purgeMembership(env, 'm1');
  assert.ok(state.tokens['ig-2'], 'm2\'s token must survive m1\'s purge');
});

test('purge deletes held and missed scheduled_posts for the membership\'s ig_user_id', async () => {
  const { env, state } = makeEnv({
    tokens: { 'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1' } },
    posts: {
      p1: { id: 'p1', ig_user_id: 'ig-1', status: 'held_entitlement', asset_keys: '[]', cover_key: null },
      p2: { id: 'p2', ig_user_id: 'ig-1', status: 'missed', asset_keys: '[]', cover_key: null },
    },
  });
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.scheduledPosts, 2);
  assert.deepEqual(state.posts, {});
});

test('purge leaves a post that already fired before the lapse untouched', async () => {
  const { env, state } = makeEnv({
    tokens: { 'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1' } },
    posts: {
      p1: { id: 'p1', ig_user_id: 'ig-1', status: 'posted', asset_keys: '[]', cover_key: null },
      p2: { id: 'p2', ig_user_id: 'ig-1', status: 'scheduled', asset_keys: '[]', cover_key: null },
    },
  });
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.scheduledPosts, 0);
  assert.equal(Object.keys(state.posts).length, 2);
});

test('purge deletes R2 objects for every asset_key and the cover_key of a held/missed post', async () => {
  const { env, r2Deleted } = makeEnv({
    tokens: { 'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1' } },
    posts: {
      p1: {
        id: 'p1', ig_user_id: 'ig-1', status: 'held_entitlement',
        asset_keys: JSON.stringify(['ig-1/reel/a.mp4']), cover_key: 'ig-1/cover/a.jpg',
      },
    },
  });
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.r2Objects, 2);
  assert.deepEqual(r2Deleted.sort(), ['ig-1/cover/a.jpg', 'ig-1/reel/a.mp4']);
});

test('an R2 delete failure is counted, not thrown — the DB row is still purged', async () => {
  const { env, r2Fail, state } = makeEnv({
    tokens: { 'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1' } },
    posts: {
      p1: {
        id: 'p1', ig_user_id: 'ig-1', status: 'held_entitlement',
        asset_keys: JSON.stringify(['ig-1/reel/a.mp4']), cover_key: null,
      },
    },
  });
  r2Fail.add('ig-1/reel/a.mp4');
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.r2Errors, 1);
  assert.equal(result.scheduledPosts, 1);
  assert.deepEqual(state.posts, {});
});

test('purge deletes the brand_kits row(s) for the membership', async () => {
  const { env, state } = makeEnv({
    kits: {
      k1: { membership_id: 'm1', slug: 'musical-philosopher', vision_gita: 'x' },
      k2: { membership_id: 'm2', slug: 'other-creator', vision_gita: 'y' },
    },
  });
  const result = await purgeMembership(env, 'm1');
  assert.equal(result.brandKits, 1);
  assert.equal(state.kits.k1, undefined);
  assert.ok(state.kits.k2, 'another creator\'s kit must survive');
});

test('purge scrubs email and stamps purged_at on the whop_memberships row, but keeps the row', async () => {
  const { env, state } = makeEnv({
    memberships: { m1: { status: 'inactive', updated_at: iso(Date.now() - 20 * DAY), email: 'creator@example.com', purged_at: null } },
  });
  await purgeMembership(env, 'm1');
  assert.equal(state.memberships.m1.email, null);
  assert.ok(state.memberships.m1.purged_at, 'purged_at must be stamped');
  assert.equal(state.memberships.m1.status, 'inactive', 'the audit row itself is never deleted');
});

// ---------------------------------------------------------------------------
// runDataRetentionPurge (orchestration)
// ---------------------------------------------------------------------------

test('the daily run purges every lapsed membership and leaves active ones alone', async () => {
  const { env, state } = makeEnv({
    memberships: {
      m1: { status: 'inactive', updated_at: iso(Date.now() - 30 * DAY), purged_at: null },
      m2: { status: 'active', updated_at: iso(Date.now() - 30 * DAY), purged_at: null },
    },
    tokens: {
      'ig-1': { ig_user_id: 'ig-1', whop_membership_id: 'm1' },
      'ig-2': { ig_user_id: 'ig-2', whop_membership_id: 'm2' },
    },
  });
  const results = await runDataRetentionPurge(env);
  assert.equal(results.length, 1);
  assert.equal(results[0].membershipId, 'm1');
  assert.equal(state.tokens['ig-1'], undefined);
  assert.ok(state.tokens['ig-2'], 'm2 is still active and must be untouched');
});

test('one membership failing to purge does not stop the others', async () => {
  const { env } = makeEnv({
    memberships: {
      m1: { status: 'inactive', updated_at: iso(Date.now() - 30 * DAY), purged_at: null },
      m2: { status: 'inactive', updated_at: iso(Date.now() - 30 * DAY), purged_at: null },
    },
  });
  const originalPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.startsWith('DELETE FROM ig_tokens')) {
      return { bind: (...args) => ({ async run() {
        if (args[0] === 'm1') throw new Error('simulated D1 failure for m1');
        return originalPrepare(sql).bind(...args).run();
      } }) };
    }
    return originalPrepare(sql);
  };
  const results = await runDataRetentionPurge(env);
  // m1 threw and is skipped from the results; m2 still completes.
  assert.deepEqual(results.map((r) => r.membershipId), ['m2']);
});
