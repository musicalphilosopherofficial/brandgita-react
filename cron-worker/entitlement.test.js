/**
 * Entitlement enforcement on the publish path — the BLACK-BOX half.
 *
 * Written BEFORE reading poster.js's implementation of the fix, per CLAUDE.md's test-stance
 * rule: security and trust-boundary work is black-box first, as a separate phase, because
 * reading the implementation first makes you audit intent instead of behaviour. The threat
 * model here is an actor without our source: a creator whose subscription has ended (card
 * bounced, cancelled, refunded) whose queued posts must not keep publishing under our name,
 * on our infrastructure, using a token we hold for them.
 *
 * The hole these cover, verified live 2026-09-19: runDue's query selected on
 * status/retry_count/post_at ONLY, with no join to ig_tokens.whop_membership_id ->
 * whop_memberships.status. A lapsed member's queue drained in full. The membership.deactivated
 * webhook nulls desktop_token, which stops the CLIENT — but the cron reads D1 directly and
 * needs no desktop token, so it kept posting.
 *
 * Separate file from poster.test.js deliberately: these assert a policy, not the posting
 * mechanics, and they should stay readable as the answer to "prove a cancelled user cannot
 * post" without being buried in 770 lines of Graph-API choreography.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimPost, runDue } from './poster.js';

const MEDIA_BASE = 'https://test-media.example/media';
const TOKEN_ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

const instantSleep = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A D1 fake that mirrors the REAL predicates, exactly as poster.test.js's does and for the
 * same stated reason: if the production SQL silently drops the entitlement join, this fake
 * stops applying it too and more rows come back than the test expects. A fake that ignored
 * the SQL text would go green against the very regression these tests exist to catch.
 */
function makeEnv({ posts = {}, tokens = {}, memberships = {} } = {}) {
  const state = {
    posts: JSON.parse(JSON.stringify(posts)),
    tokens: JSON.parse(JSON.stringify(tokens)),
    memberships: JSON.parse(JSON.stringify(memberships)),
  };
  const writes = [];

  /** The join the production query must perform: post -> ig_tokens -> whop_memberships.status */
  function membershipStatusFor(post) {
    const tok = state.tokens[post.ig_user_id];
    if (!tok || !tok.whop_membership_id) return null;      // legacy row, membership unknown
    const m = state.memberships[tok.whop_membership_id];
    return m ? m.status : null;
  }

  function entitled(post) {
    return membershipStatusFor(post) === 'active';
  }

  function statement(sql) {
    const bound = (args) => ({
      async first() { return execFirst(sql, args); },
      async run() { return execRun(sql, args); },
      async all() { return execAll(sql, args); },
    });
    return Object.assign(bound([]), { bind: (...args) => bound(args) });
  }

  function execFirst(sql, args) {
    if (sql.includes('SELECT access_token FROM ig_tokens WHERE ig_user_id = ?')) {
      const [igUserId] = args;
      return state.tokens[igUserId] || null;
    }
    if (sql.includes('COUNT(*) AS n FROM scheduled_posts')) {
      let rows = Object.values(state.posts);
      if (sql.includes(`status = 'scheduled'`)) rows = rows.filter((r) => r.status === 'scheduled');
      if (sql.includes('retry_count < 5')) rows = rows.filter((r) => (r.retry_count ?? 0) < 5);
      return { n: rows.length };
    }
    if (sql.includes('COUNT(*) AS n FROM ig_tokens')) return { n: Object.values(state.tokens).length };
    throw new Error(`fake D1: unhandled .first() SQL: ${sql}`);
  }

  function execAll(sql) {
    if (sql.includes('SELECT') && sql.includes('scheduled_posts')) {
      let rows = Object.values(state.posts);
      if (sql.includes(`status = 'scheduled'`)) rows = rows.filter((r) => r.status === 'scheduled');
      if (sql.includes('retry_count < 5')) rows = rows.filter((r) => (r.retry_count ?? 0) < 5);
      // Mirror the entitlement join only when the SQL actually asks for it. Drop the
      // predicate in production and this fake stops filtering — which is the regression.
      if (sql.includes('whop_memberships')) rows = rows.filter(entitled);
      if (sql.includes('LIMIT 10')) rows = rows.slice(0, 10);
      return { results: rows };
    }
    if (sql.includes('SELECT ig_user_id, access_token FROM ig_tokens')) {
      return { results: Object.values(state.tokens) };
    }
    throw new Error(`fake D1: unhandled .all() SQL: ${sql}`);
  }

  function execRun(sql, args) {
    writes.push({ sql, args });
    if (sql.includes(`SET status = 'posting'`)) {
      const [id] = args;
      const row = state.posts[id];
      // The CAS must not hand out a claim for a post whose owner is not entitled, even if
      // the row was selected a moment ago — a membership can lapse between query and claim.
      const guarded = sql.includes('whop_memberships');
      if (row && row.status === 'scheduled' && (!guarded || entitled(row))) {
        row.status = 'posting';
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes(`SET status = 'held_entitlement'`)) {
      const [, id] = args;
      const row = state.posts[id];
      if (row) row.status = 'held_entitlement';
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes(`SET status = 'posted'`)) {
      const [permalink, id] = args;
      const row = state.posts[id];
      if (row) { row.status = 'posted'; row.permalink = permalink; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes('UPDATE ig_tokens SET access_token')) return { meta: { changes: 0 } };
    if (sql.includes('scheduled_posts')) return { meta: { changes: 0 } };
    throw new Error(`fake D1: unhandled .run() SQL: ${sql}`);
  }

  return { env: { DB: { prepare: (sql) => statement(sql) }, TOKEN_ENC_KEY }, state, writes };
}

const post = (over = {}) => ({
  id: 'post-1',
  ig_user_id: 'ig-user-1',
  type: 'reel',
  asset_keys: JSON.stringify(['clip.mp4']),
  cover_key: null,
  caption: 'hello',
  status: 'scheduled',
  retry_count: 0,
  post_at: new Date(Date.now() - 60_000).toISOString(),
  permalink: null,
  error: null,
  ...over,
});

const tokenRow = (over = {}) => ({
  ig_user_id: 'ig-user-1',
  access_token: 'plaintext-token',
  token_expiry: new Date(Date.now() + 30 * 86400_000).toISOString(),
  updated_at: new Date().toISOString(),
  whop_membership_id: 'mem-1',
  ...over,
});

const membership = (over = {}) => ({ membership_id: 'mem-1', status: 'active', ...over });

/**
 * Records every Graph call by replacing globalThis.fetch — the same mechanism poster.test.js
 * uses, because runDue takes no fetchImpl dep. Getting this wrong is not a harmless detail:
 * the first draft of these tests passed a `fetchImpl` that runDue ignores, so the REAL fetch
 * ran, failed, was swallowed by processPost's error handling, and every "no post was
 * published" assertion went green for the wrong reason. The control test below ("an active
 * member is unaffected") exists solely to catch that class of vacuous pass.
 *
 * Responses are canned so an ENTITLED post can run the full reel flow to completion; an
 * unentitled one should never get far enough to need them.
 */
function installFetchRecorder() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method || 'GET' });
    const body = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('fields=status_code')) return body({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return body({ permalink: 'https://instagram.com/p/x' });
    return body({ id: 'container-1' });
  };
  return calls;
}

test('a cancelled member: their due post is never published', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow() },
    memberships: { 'mem-1': membership({ status: 'inactive' }) },
  });
  const calls = installFetchRecorder();
  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.equal(calls.length, 0, 'a lapsed member must produce ZERO Graph API calls');
  assert.notEqual(state.posts['post-1'].status, 'posted');
});

test('an active member is unaffected — the gate blocks the lapsed, not everyone', async () => {
  const { env } = makeEnv({
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow() },
    memberships: { 'mem-1': membership({ status: 'active' }) },
  });
  const calls = installFetchRecorder();
  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.ok(calls.length > 0, 'an entitled member\'s post must still be picked up and attempted');
});

test('an account with no linked membership is not published (fail closed)', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow({ whop_membership_id: null }) },
    memberships: {},
  });
  const calls = installFetchRecorder();
  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });

  assert.equal(calls.length, 0, 'unknown entitlement must fail closed, not open');
  assert.notEqual(state.posts['post-1'].status, 'posted');
});

test('a membership whose row vanished is not published', async () => {
  const { env } = makeEnv({
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow({ whop_membership_id: 'mem-gone' }) },
    memberships: {},
  });
  const calls = installFetchRecorder();
  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });
  assert.equal(calls.length, 0);
});

test('one lapsed member does not stop an entitled member in the same tick', async () => {
  const { env } = makeEnv({
    posts: {
      'post-lapsed': post({ id: 'post-lapsed', ig_user_id: 'ig-lapsed' }),
      'post-ok': post({ id: 'post-ok', ig_user_id: 'ig-ok' }),
    },
    tokens: {
      'ig-lapsed': tokenRow({ ig_user_id: 'ig-lapsed', whop_membership_id: 'mem-lapsed' }),
      'ig-ok': tokenRow({ ig_user_id: 'ig-ok', whop_membership_id: 'mem-ok' }),
    },
    memberships: {
      'mem-lapsed': membership({ membership_id: 'mem-lapsed', status: 'inactive' }),
      'mem-ok': membership({ membership_id: 'mem-ok', status: 'active' }),
    },
  });
  const calls = installFetchRecorder();
  await runDue(env, { mediaBase: MEDIA_BASE, sleepFn: instantSleep });
  const attempted = calls.map((c) => c.url);

  assert.ok(attempted.length > 0, 'the entitled member must still be attempted');
  assert.ok(
    !attempted.some((u) => u.includes('ig-lapsed')),
    'no Graph call may reference the lapsed member',
  );
});

test('claimPost refuses a post whose membership lapsed between query and claim', async () => {
  const { env, state } = makeEnv({
    posts: { 'post-1': post() },
    tokens: { 'ig-user-1': tokenRow() },
    memberships: { 'mem-1': membership({ status: 'inactive' }) },
  });
  const claimed = await claimPost(env, 'post-1');

  assert.equal(claimed, false, 'the claim CAS must re-check entitlement, not just status');
  assert.equal(state.posts['post-1'].status, 'scheduled');
});
