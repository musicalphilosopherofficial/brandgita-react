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
