// Regression test for a critical bug found 2026-08-30 running the real cron poller
// against production: `post_at <= datetime('now')` and `token_expiry <= datetime('now',
// '+7 days')` are LEXICOGRAPHIC STRING comparisons in SQLite, not date comparisons. Real
// timestamps are stored via `new Date(...).toISOString()` ("2026-08-30T12:00:00.000Z"),
// while SQLite's own datetime('now') returns "2026-08-30 12:00:00" (space, no ms, no Z).
// 'T' (0x54) sorts after ' ' (0x20), so ANY real ISO timestamp compares as "later than
// now" regardless of the actual date — a post scheduled an hour in the PAST never
// evaluates as due, and a token expiring tomorrow never evaluates as needing refresh.
//
// This uses a REAL SQLite engine (node:sqlite), not a JS mock — the fake-D1 test doubles
// used elsewhere in this repo don't execute real SQL date-comparison semantics, which is
// exactly why 210 other passing tests never caught this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

test('BUG (documented): bare `post_at <= datetime(\'now\')` never matches a real ISO timestamp', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (post_at TEXT)');
  const insert = db.prepare('INSERT INTO t (post_at) VALUES (?)');
  insert.run(isoNow(-60 * 60 * 1000)); // scheduled 1 HOUR AGO — must be "due"

  const dueRows = db.prepare(`SELECT * FROM t WHERE post_at <= datetime('now')`).all();
  // This asserts the BUG's behavior on purpose — proving the old query was broken.
  assert.equal(dueRows.length, 0, 'the broken query wrongly finds 0 due posts');
});

test('FIX: `datetime(post_at) <= datetime(\'now\')` correctly finds a post scheduled in the past', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (post_at TEXT)');
  const insert = db.prepare('INSERT INTO t (post_at) VALUES (?)');
  insert.run(isoNow(-60 * 60 * 1000)); // 1 hour ago — due
  insert.run(isoNow(60 * 60 * 1000)); // 1 hour from now — NOT due

  const dueRows = db.prepare(`SELECT * FROM t WHERE datetime(post_at) <= datetime('now')`).all();
  assert.equal(dueRows.length, 1, 'exactly the past-scheduled row should be due');
});

test('FIX: token_expiry refresh-sweep correctly finds a token expiring within the window', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ig_tokens (token_expiry TEXT)');
  const insert = db.prepare('INSERT INTO ig_tokens (token_expiry) VALUES (?)');
  insert.run(isoNow(3 * 24 * 60 * 60 * 1000)); // expires in 3 days — inside the 7-day window
  insert.run(isoNow(30 * 24 * 60 * 60 * 1000)); // expires in 30 days — outside the window
  insert.run(isoNow(-24 * 60 * 60 * 1000)); // already expired — inside the window too

  const rows = db
    .prepare(`SELECT * FROM ig_tokens WHERE datetime(token_expiry) <= datetime('now', '+7 days')`)
    .all();
  assert.equal(rows.length, 2, 'the 3-day and already-expired tokens should both need refresh');
});

// ---------------------------------------------------------------------------
// The DIAGNOSTIC layer: proving the "matched X of Y" logs can actually see the
// bug above. Enabling retained Workers Logs is worthless if the one path that
// broke says nothing distinguishable — and "matched 0 row(s)" is emitted
// identically by an empty queue and by a filter that can never match. These
// tests assert the denominator separates those two, against a REAL SQLite
// engine for the same reason the tests above use one.
// ---------------------------------------------------------------------------

function seedScheduledPosts(db, count) {
  db.exec(`CREATE TABLE scheduled_posts (post_at TEXT, status TEXT, retry_count INTEGER)`);
  const insert = db.prepare(
    'INSERT INTO scheduled_posts (post_at, status, retry_count) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < count; i += 1) insert.run(isoNow(-60 * 60 * 1000), 'scheduled', 0);
}

const DUE_FILTER_BROKEN = `post_at <= datetime('now')`;
const DUE_FILTER_FIXED = `datetime(post_at) <= datetime('now')`;
// The denominator deliberately OMITS the datetime comparison under suspicion and
// keeps the rest — counting the caller's own predicate would be tautological.
const ELIGIBLE_COUNT = `SELECT COUNT(*) AS n FROM scheduled_posts
                         WHERE status = 'scheduled' AND retry_count < 5`;

test('DIAGNOSTIC: matched-count ALONE cannot distinguish the bug from an empty queue', () => {
  const broken = new DatabaseSync(':memory:');
  seedScheduledPosts(broken, 7); // 7 posts, all an hour overdue — all SHOULD fire

  const empty = new DatabaseSync(':memory:');
  seedScheduledPosts(empty, 0); // genuinely nothing scheduled

  const brokenMatched = broken
    .prepare(`SELECT * FROM scheduled_posts WHERE ${DUE_FILTER_BROKEN}`).all().length;
  const emptyMatched = empty
    .prepare(`SELECT * FROM scheduled_posts WHERE ${DUE_FILTER_FIXED}`).all().length;

  assert.equal(brokenMatched, 0, '59bbbcc: seven overdue posts, zero matched, nothing thrown');
  assert.equal(emptyMatched, 0, 'an empty queue also matches zero');
  // Identical observable output from a catastrophic bug and a quiet Tuesday.
  assert.equal(
    `matched ${brokenMatched} row(s)`,
    `matched ${emptyMatched} row(s)`,
    'the pre-denominator log line is IDENTICAL in both cases — this is the blindness'
  );
});

test('DIAGNOSTIC: the denominator makes the bug and the empty queue distinguishable', () => {
  const broken = new DatabaseSync(':memory:');
  seedScheduledPosts(broken, 7);

  const empty = new DatabaseSync(':memory:');
  seedScheduledPosts(empty, 0);

  const brokenLine = `matched ${
    broken.prepare(`SELECT * FROM scheduled_posts WHERE ${DUE_FILTER_BROKEN}`).all().length
  } of ${broken.prepare(ELIGIBLE_COUNT).get().n} eligible row(s)`;

  const emptyLine = `matched ${
    empty.prepare(`SELECT * FROM scheduled_posts WHERE ${DUE_FILTER_FIXED}`).all().length
  } of ${empty.prepare(ELIGIBLE_COUNT).get().n} eligible row(s)`;

  assert.equal(brokenLine, 'matched 0 of 7 eligible row(s)', 'the bug is now legible');
  assert.equal(emptyLine, 'matched 0 of 0 eligible row(s)', 'a quiet run is legible too');
  assert.notEqual(brokenLine, emptyLine, 'the whole point: these must not look the same');
});

test('DIAGNOSTIC: the fixed query reports matched == eligible once the filter works', () => {
  const db = new DatabaseSync(':memory:');
  seedScheduledPosts(db, 7);

  const matched = db.prepare(`SELECT * FROM scheduled_posts WHERE ${DUE_FILTER_FIXED}`).all().length;
  assert.equal(
    `matched ${matched} of ${db.prepare(ELIGIBLE_COUNT).get().n} eligible row(s)`,
    'matched 7 of 7 eligible row(s)'
  );
});

test('DIAGNOSTIC: the denominator ignores rows the due-filter was never selecting from', () => {
  const db = new DatabaseSync(':memory:');
  seedScheduledPosts(db, 2);
  const insert = db.prepare(
    'INSERT INTO scheduled_posts (post_at, status, retry_count) VALUES (?, ?, ?)'
  );
  insert.run(isoNow(-60 * 60 * 1000), 'posted', 0); // already published
  insert.run(isoNow(-60 * 60 * 1000), 'scheduled', 9); // past the retry cap

  // Counting every row would inflate the denominator into permanent false alarm.
  assert.equal(db.prepare(ELIGIBLE_COUNT).get().n, 2, 'only genuinely eligible rows count');
});
