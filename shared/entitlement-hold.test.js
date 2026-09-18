/**
 * The park-and-resume rule, and the one thing most likely to break it: the grace boundary
 * being expressed twice — once as JS (resumeStatusFor, used to EXPLAIN a held post in the
 * Schedule screen) and once as SQL (resumeHeldPosts, which performs the transition).
 *
 * The boundary tests below deliberately sit at exactly 6h, and at 6h ± a minute, because an
 * off-by-one there is the difference between a creator's post going out four hours late and
 * being silently withheld. `poster.js` already carries a scar from a date comparison that
 * looked right and was not (the 2026-08-30 lexicographic post_at bug meant NO post could ever
 * fire), so time predicates in this codebase get pinned, not trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resumeStatusFor, holdPostsForMembership, resumeHeldPosts,
  HOLD_GRACE_HOURS, HELD, MISSED, SCHEDULED,
} from './entitlement-hold.js';

const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

test('a post still in the future is released untouched', () => {
  const now = Date.now();
  assert.equal(resumeStatusFor(iso(now + 2 * HOUR), now), SCHEDULED);
});

test('a post that missed its slot by an hour still goes out', () => {
  const now = Date.now();
  assert.equal(resumeStatusFor(iso(now - HOUR), now), SCHEDULED);
});

test('the grace boundary is inclusive — exactly 6h late still fires', () => {
  const now = Date.now();
  assert.equal(resumeStatusFor(iso(now - HOLD_GRACE_HOURS * HOUR), now), SCHEDULED);
});

test('a minute past the grace is missed, not fired', () => {
  const now = Date.now();
  assert.equal(resumeStatusFor(iso(now - (HOLD_GRACE_HOURS * HOUR + 60_000)), now), MISSED);
});

test('a post days late is missed — never published in a burst on resume', () => {
  const now = Date.now();
  assert.equal(resumeStatusFor(iso(now - 5 * 24 * HOUR), now), MISSED);
});

test('an unparseable post_at is missed, never published on a guess', () => {
  assert.equal(resumeStatusFor('not-a-date', Date.now()), MISSED);
  assert.equal(resumeStatusFor(null, Date.now()), MISSED);
});

// ---------------------------------------------------------------------------
// The D1 transitions
// ---------------------------------------------------------------------------

/**
 * Fake D1 that interprets the two statements under test, including the CASE's time
 * comparison — mirroring the real predicate for the same reason poster.test.js does: a fake
 * that ignored the SQL would go green even if the CASE were inverted.
 */
function makeEnv({ posts = {}, tokens = {} } = {}) {
  const state = { posts: JSON.parse(JSON.stringify(posts)), tokens: JSON.parse(JSON.stringify(tokens)) };

  const ownedBy = (membershipId) => new Set(
    Object.values(state.tokens)
      .filter((t) => t.whop_membership_id === membershipId)
      .map((t) => t.ig_user_id),
  );

  return {
    state,
    env: {
      DB: {
        prepare: (sql) => ({
          bind: (...args) => ({
            async run() {
              let changes = 0;

              if (sql.includes('held_at = datetime(\'now\')')) {
                const [held, fromStatus, membershipId] = args;
                const mine = ownedBy(membershipId);
                for (const row of Object.values(state.posts)) {
                  if (row.status === fromStatus && mine.has(row.ig_user_id)) {
                    row.status = held;
                    row.held_at = new Date().toISOString();
                    changes += 1;
                  }
                }
                return { meta: { changes } };
              }

              if (sql.includes('CASE')) {
                const [modifier, scheduled, missed, fromStatus, membershipId] = args;
                const hours = Number(String(modifier).match(/-(\d+) hours/)?.[1] ?? 0);
                const cutoff = Date.now() - hours * HOUR;   // datetime('now', '-N hours')
                const mine = ownedBy(membershipId);
                for (const row of Object.values(state.posts)) {
                  if (row.status === fromStatus && mine.has(row.ig_user_id)) {
                    // WHEN datetime(post_at) > datetime('now', '-6 hours')
                    row.status = Date.parse(row.post_at) > cutoff ? scheduled : missed;
                    row.held_at = null;
                    changes += 1;
                  }
                }
                return { meta: { changes } };
              }

              throw new Error(`fake D1: unhandled SQL: ${sql}`);
            },
          }),
        }),
      },
    },
  };
}

const post = (over = {}) => ({
  id: 'p1', ig_user_id: 'ig-1', status: SCHEDULED,
  post_at: iso(Date.now() + HOUR), held_at: null, ...over,
});
const token = (over = {}) => ({ ig_user_id: 'ig-1', whop_membership_id: 'mem-1', ...over });

test('a lapse parks every scheduled post for that membership', async () => {
  const { env, state } = makeEnv({
    posts: { p1: post(), p2: post({ id: 'p2' }) },
    tokens: { 'ig-1': token() },
  });
  const held = await holdPostsForMembership(env, 'mem-1');

  assert.equal(held, 2);
  assert.equal(state.posts.p1.status, HELD);
  assert.ok(state.posts.p1.held_at, 'held_at records when it was parked');
});

test('a post already mid-publish is left alone — Instagram already has it', async () => {
  const { env, state } = makeEnv({
    posts: { p1: post({ status: 'posting' }) },
    tokens: { 'ig-1': token() },
  });
  const held = await holdPostsForMembership(env, 'mem-1');

  assert.equal(held, 0);
  assert.equal(state.posts.p1.status, 'posting');
});

test('parking is idempotent — a redelivered webhook re-parks nothing', async () => {
  const { env } = makeEnv({ posts: { p1: post() }, tokens: { 'ig-1': token() } });
  assert.equal(await holdPostsForMembership(env, 'mem-1'), 1);
  assert.equal(await holdPostsForMembership(env, 'mem-1'), 0);
});

test('one member lapsing never touches another member\'s queue', async () => {
  const { env, state } = makeEnv({
    posts: { mine: post({ id: 'mine' }), theirs: post({ id: 'theirs', ig_user_id: 'ig-2' }) },
    tokens: { 'ig-1': token(), 'ig-2': token({ ig_user_id: 'ig-2', whop_membership_id: 'mem-2' }) },
  });
  await holdPostsForMembership(env, 'mem-1');

  assert.equal(state.posts.mine.status, HELD);
  assert.equal(state.posts.theirs.status, SCHEDULED, 'an unrelated membership is untouched');
});

test('paying releases future and recently-missed posts, and only those', async () => {
  const now = Date.now();
  const { env, state } = makeEnv({
    posts: {
      future: post({ id: 'future', status: HELD, post_at: iso(now + 2 * HOUR) }),
      recent: post({ id: 'recent', status: HELD, post_at: iso(now - HOUR) }),
      stale: post({ id: 'stale', status: HELD, post_at: iso(now - 5 * 24 * HOUR) }),
    },
    tokens: { 'ig-1': token() },
  });
  await resumeHeldPosts(env, 'mem-1');

  assert.equal(state.posts.future.status, SCHEDULED);
  assert.equal(state.posts.recent.status, SCHEDULED);
  assert.equal(state.posts.stale.status, MISSED, 'a 5-day-late post must not fire unasked');
  assert.equal(state.posts.stale.held_at, null, 'held_at is cleared once the hold resolves');
});

test('the SQL transition and the JS rule agree at the boundary', async () => {
  const now = Date.now();
  const cases = [now + HOUR, now - HOUR, now - (HOLD_GRACE_HOURS * HOUR - 60_000),
    now - (HOLD_GRACE_HOURS * HOUR + 60_000), now - 5 * 24 * HOUR];

  for (const at of cases) {
    const { env, state } = makeEnv({
      posts: { p1: post({ status: HELD, post_at: iso(at) }) },
      tokens: { 'ig-1': token() },
    });
    await resumeHeldPosts(env, 'mem-1');
    assert.equal(
      state.posts.p1.status, resumeStatusFor(iso(at), now),
      `SQL and JS disagree for a post at ${iso(at)} — the grace constant has drifted`,
    );
  }
});
