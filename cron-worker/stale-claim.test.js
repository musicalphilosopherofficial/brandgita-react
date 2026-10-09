// A post stuck in 'posting' must be reaped, and a missed window must alert — for EVERY platform.
// Run: node --test cron-worker/stale-claim.test.js
//
// Observed 2026-10-09: an Instagram reel due 12:00 NZDT sat in 'posting' for 4.5+ hours with no
// error and no media id. claimPost flips scheduled -> posting and runDue only selects 'scheduled', so
// when the worker died mid-attempt nothing ever reset, retried or reported it — the code that would
// (handleRetryableFailure / raisePostFailure) was the code that died.
//
// These tests run against a REAL SQLite engine built from the repo's own migration files, not a fake
// that dispatches on SQL text: the reaper's whole job is datetime() comparison, which a string-matching
// fake cannot exercise (see due-date-comparison.test.js for the bug that taught us that).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runDue, claimPost, reapStaleClaims, logLateRows } from './poster.js';
import { ADAPTERS } from './platforms/index.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const TOKEN_ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const noSleep = () => new Promise((r) => setTimeout(r, 0));

let db;
let env;

function freshDb() {
  const d = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    // The waitlist migrations (0001/0003/0005) alter a table this worker never touches.
    try { d.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; }
  }
  return d;
}

// A D1-shaped shim over node:sqlite, so poster.js runs unmodified.
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

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
// SQLite's own format, which is what datetime('now') writes into posting_since.
const sqliteAgo = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19);

function seedUser() {
  db.prepare(`INSERT INTO whop_memberships (membership_id, whop_user_id, status) VALUES ('mem1','u1','active')`).run();
  db.prepare(`INSERT INTO ig_tokens (ig_user_id, access_token, whop_membership_id, token_expiry) VALUES ('ig1','plaintext-token','mem1', ?)`)
    .run(new Date(Date.now() + 30 * 86_400_000).toISOString());
}

function seedPost(over = {}) {
  const row = {
    id: 'p1', ig_user_id: 'ig1', type: 'reel', asset_keys: JSON.stringify(['ig1/reel/a.mp4']), caption: 'hi',
    post_at: minutesAgo(30), status: 'posting', retry_count: 0, posting_since: sqliteAgo(60), platform: 'ig',
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO scheduled_posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
  return row.id;
}
const rowOf = (id) => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);
const tickets = () => db.prepare(`SELECT * FROM bug_reports`).all();

// Instagram Graph stub: records every call; `failAll` makes every call fail like an outage.
function stubGraph({ failAll = false } = {}) {
  const calls = [];
  const json = (d, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => d });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method || 'GET'} ${new URL(u).pathname}`);
    if (failAll) return json({ error: { message: 'Graph is down', code: 2 } }, false);
    if (u.includes('/media_publish')) return json({ id: 'MEDIA1' });
    if (u.endsWith('/media')) return json({ id: 'CONTAINER1' });
    if (u.includes('/CONTAINER1')) return json({ status_code: 'FINISHED' });
    if (u.includes('/MEDIA1')) return json({ permalink: 'https://instagram.com/reel/X/' });
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}
const deps = { mediaBase: 'https://m.example/media', sleepFn: noSleep, pollIntervalMs: 0, pollMaxMs: 5000 };

beforeEach(() => {
  db = freshDb();
  env = { DB: d1(db), TOKEN_ENC_KEY };
  seedUser();
});

// ── the claim records when it started ────────────────────────────────────────

test('claimPost stamps posting_since in the same statement that flips the status', async () => {
  seedPost({ id: 'c1', status: 'scheduled', posting_since: null });
  assert.equal(await claimPost(env, 'c1'), true);
  const r = rowOf('c1');
  assert.equal(r.status, 'posting');
  assert.ok(r.posting_since, 'posting_since must be set by the claim');
  assert.ok(Math.abs(Date.parse(r.posting_since.replace(' ', 'T') + 'Z') - Date.now()) < 60_000);
});

// ── the reaper ───────────────────────────────────────────────────────────────

test('a claim older than 10 minutes with NO published id is requeued and counts as an attempt', async () => {
  stubGraph({ failAll: true }); // so the requeued post cannot publish during this run and mask the state
  seedPost({ status: 'posting', posting_since: sqliteAgo(11), retry_count: 1, post_at: minutesAgo(5) });
  await runDue(env, deps);
  const r = rowOf('p1');
  // reaped (retry 1 -> 2) and then retried once by this same run (2 -> 3) against the failing Graph
  assert.ok(r.retry_count >= 2, `retry_count should have advanced, was ${r.retry_count}`);
  assert.notEqual(r.status, 'posting');
});

test('reaping alone: requeued as scheduled, retry_count + 1, error says the attempt was abandoned', async () => {
  seedPost({ status: 'posting', posting_since: sqliteAgo(11), retry_count: 1, post_at: minutesAgo(5) });
  stubGraph({ failAll: true });
  // Not due yet from the due-query's point of view is not possible here, so prove the reaper directly.
  await reapStaleClaims(env);
  const r = rowOf('p1');
  assert.equal(r.status, 'scheduled');
  assert.equal(r.retry_count, 2);
  assert.match(r.error, /abandoned/i);
});

test('a stale claim whose publish id is already saved goes back to scheduled WITHOUT a new attempt', async () => {
  seedPost({ status: 'posting', posting_since: sqliteAgo(11), retry_count: 1, ig_media_id: 'MEDIA1' });
  await reapStaleClaims(env);
  const r = rowOf('p1');
  assert.equal(r.status, 'scheduled');
  assert.equal(r.retry_count, 1, 'retry_count must not move — the post is already live');
  assert.match(r.error, /abandoned/i);
});

test('…and the retry only fetches the permalink: NO container, NO media_publish', async () => {
  const calls = stubGraph();
  seedPost({ status: 'posting', posting_since: sqliteAgo(11), ig_media_id: 'MEDIA1' });
  await runDue(env, deps);
  assert.equal(calls.some((c) => c.includes('media_publish')), false, 'must never publish a second copy');
  assert.equal(calls.some((c) => c.endsWith('/ig1/media')), false, 'must never create a new container');
  const r = rowOf('p1');
  assert.equal(r.status, 'posted');
  assert.equal(r.permalink, 'https://instagram.com/reel/X/');
});

test('a claim younger than 10 minutes is left alone — a slow reel is never double-claimed', async () => {
  seedPost({ status: 'posting', posting_since: sqliteAgo(2), retry_count: 0 });
  const calls = stubGraph();
  await runDue(env, deps);
  const r = rowOf('p1');
  assert.equal(r.status, 'posting');
  assert.equal(r.retry_count, 0);
  assert.equal(calls.length, 0, 'nothing may touch a live claim');
});

test('a claim with NULL posting_since (made before the migration) counts as stale', async () => {
  seedPost({ status: 'posting', posting_since: null, retry_count: 0, post_at: minutesAgo(5) });
  await reapStaleClaims(env);
  assert.equal(rowOf('p1').status, 'scheduled');
});

test('the 5th abandoned attempt fails the post permanently and raises a ticket', async () => {
  seedPost({ status: 'posting', posting_since: sqliteAgo(30), retry_count: 4 });
  await reapStaleClaims(env);
  const r = rowOf('p1');
  assert.equal(r.status, 'failed');
  assert.equal(r.retry_count, 5);
  assert.equal(tickets().length, 1);
});

test('a row that already finished (posted) is never touched by the reaper', async () => {
  seedPost({ status: 'posted', posting_since: sqliteAgo(60) });
  await reapStaleClaims(env);
  assert.equal(rowOf('p1').status, 'posted');
});

// ── structured audit logging (Cloudflare logs are the record) ────────────────

// Spy on console.error and return the parsed JSON lines whose `event` matches.
function spyLogs() {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('{')) {
      try { lines.push(JSON.parse(first)); } catch { /* not ours */ }
    }
  };
  return { lines, restore: () => { console.error = orig; } };
}
const FIELDS = ['post_id', 'platform', 'status_before', 'minutes_late', 'retry_count', 'action'];

test('a reaped claim writes one structured line with every required field', async () => {
  const spy = spyLogs();
  try {
    seedPost({ status: 'posting', posting_since: sqliteAgo(11), retry_count: 1, post_at: minutesAgo(30) });
    await reapStaleClaims(env);
  } finally { spy.restore(); }
  const reaped = spy.lines.filter((l) => l.event === 'poster.stale_claim_reaped');
  assert.equal(reaped.length, 1);
  for (const f of FIELDS) assert.ok(f in reaped[0], `missing field ${f}`);
  assert.equal(reaped[0].post_id, 'p1');
  assert.equal(reaped[0].platform, 'ig');
  assert.equal(reaped[0].status_before, 'posting');
  assert.ok(reaped[0].minutes_late >= 29 && reaped[0].minutes_late <= 31);
  assert.equal(reaped[0].retry_count, 2);
  assert.equal(reaped[0].action, 'requeued');
});

test('the reaper logs the action it took: permalink-only retry, and failed permanently', async () => {
  const spy = spyLogs();
  try {
    seedPost({ id: 'live', status: 'posting', posting_since: sqliteAgo(11), ig_media_id: 'MEDIA1', retry_count: 1 });
    seedPost({ id: 'dead', status: 'posting', posting_since: sqliteAgo(11), retry_count: 4 });
    await reapStaleClaims(env);
  } finally { spy.restore(); }
  const byId = Object.fromEntries(spy.lines.filter((l) => l.event === 'poster.stale_claim_reaped').map((l) => [l.post_id, l]));
  assert.equal(byId.live.action, 'permalink-only retry');
  assert.equal(byId.live.retry_count, 1);
  assert.equal(byId.dead.action, 'failed permanently');
  assert.equal(byId.dead.retry_count, 5);
});

test('there is NO de-duplication: the reaper logs every time it acts', async () => {
  const spy = spyLogs();
  try {
    seedPost({ status: 'posting', posting_since: sqliteAgo(11), retry_count: 0 });
    await reapStaleClaims(env);
    db.prepare(`UPDATE scheduled_posts SET status = 'posting', posting_since = ? WHERE id = 'p1'`).run(sqliteAgo(11));
    await reapStaleClaims(env);
  } finally { spy.restore(); }
  assert.equal(spy.lines.filter((l) => l.event === 'poster.stale_claim_reaped').length, 2);
});

test('every still-live row (scheduled/posting) 15+ minutes past post_at is logged, every run', async () => {
  stubGraph({ failAll: true });
  const spy = spyLogs();
  try {
    seedPost({ id: 'late', status: 'scheduled', posting_since: null, post_at: minutesAgo(20), retry_count: 0 });
    seedPost({ id: 'ontime', status: 'scheduled', posting_since: null, post_at: minutesAgo(5), retry_count: 0 });
    seedPost({ id: 'done', status: 'posted', posting_since: null, post_at: minutesAgo(90) });
    seedPost({ id: 'gone', status: 'cancelled', posting_since: null, post_at: minutesAgo(90) });
    seedPost({ id: 'dead', status: 'failed', posting_since: null, post_at: minutesAgo(90), retry_count: 5 });
    await logLateRows(env);
    await logLateRows(env);
  } finally { spy.restore(); }
  const late = spy.lines.filter((l) => l.event === 'poster.late_row');
  // 'dead' (failed) is not here: it was logged once when it failed, not every minute for a week.
  assert.deepEqual(late.map((l) => l.post_id), ['late', 'late']);
  for (const f of FIELDS) assert.ok(f in late[0], `missing field ${f}`);
  assert.equal(late[0].status_before, 'scheduled');
  assert.ok(late[0].minutes_late >= 19 && late[0].minutes_late <= 21);
});

test('a late row is logged and requeued, and NO ticket is raised for lateness', async () => {
  stubGraph({ failAll: true }); // the requeued post keeps failing in this run, which must still not ticket it
  const spy = spyLogs();
  try {
    seedPost({ status: 'posting', posting_since: sqliteAgo(60), retry_count: 0, post_at: minutesAgo(90) });
    await runDue(env, deps);
  } finally { spy.restore(); }
  assert.ok(spy.lines.some((l) => l.event === 'poster.stale_claim_reaped' && l.action === 'requeued'));
  assert.ok(spy.lines.some((l) => l.event === 'poster.late_row'));
  assert.equal(rowOf('p1').status, 'scheduled', 'requeued with retries left');
  assert.equal(tickets().length, 0, 'lateness and abandoned attempts never raise a ticket');
});

test('a late post with retries left publishes on the next run, however late', async () => {
  const calls = stubGraph();
  seedPost({ status: 'posting', posting_since: sqliteAgo(60 * 5), retry_count: 0, post_at: minutesAgo(60 * 5) });
  await runDue(env, deps);
  assert.equal(rowOf('p1').status, 'posted');
  assert.ok(calls.some((c) => c.includes('media_publish')));
  assert.equal(tickets().length, 0);
});

// ── the platform contract ────────────────────────────────────────────────────

test('every adapter declares the column that holds its published id, and that column exists', () => {
  const cols = new Set(db.prepare('PRAGMA table_info(scheduled_posts)').all().map((c) => c.name));
  for (const [platform, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(typeof adapter.publishedIdColumn, 'string', `${platform}: adapter must declare publishedIdColumn`);
    assert.ok(cols.has(adapter.publishedIdColumn), `${platform}: publishedIdColumn "${adapter.publishedIdColumn}" is not a scheduled_posts column`);
  }
});
