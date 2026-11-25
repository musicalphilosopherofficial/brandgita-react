// The scheduled_posts table must accept every content type a platform contract declares.
// Run: node --test shared/scheduled-posts-schema.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CONTRACTS } from './platform-contracts.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
function freshDb() {
  const d = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    try { d.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; }
  }
  return d;
}
const insert = (d, id, platform, type) => d.prepare(
  `INSERT INTO scheduled_posts (id, ig_user_id, type, asset_keys, post_at, platform) VALUES (?, 'u', ?, '[]', '2030-01-01T00:00:00Z', ?)`,
).run(id, type, platform);

test('every (platform, content type) a contract declares can be stored — the database does not own the type vocabulary', () => {
  const d = freshDb();
  let n = 0;
  for (const [platform, c] of Object.entries(CONTRACTS)) for (const type of c.contentTypes) insert(d, `r${n++}`, platform, type);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM scheduled_posts').get().n, n);
});

test('the rebuild lost nothing: every column and the due-query index survive', () => {
  const d = freshDb();
  const cols = d.prepare(`SELECT name FROM pragma_table_info('scheduled_posts')`).all().map((r) => r.name);
  for (const c of ['id', 'ig_user_id', 'type', 'asset_keys', 'cover_key', 'caption', 'post_at', 'status', 'permalink', 'error',
    'retry_count', 'created_at', 'platform', 'held_at', 'ig_media_id', 'media_purged_at', 'posting_since', 'trial_strategy',
    'tiktok_options', 'tt_publish_id']) assert.ok(cols.includes(c), `column ${c}`);
  assert.ok(d.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_scheduled_posts_post_at'`).get());
});

test('the rebuild preserves existing rows', () => {
  const d = new DatabaseSync(':memory:');
  const files = fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  const last = files.at(-1);
  for (const f of files.slice(0, -1)) { try { d.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; } }
  d.prepare(`INSERT INTO scheduled_posts (id, ig_user_id, type, asset_keys, post_at, caption, status, tt_publish_id) VALUES ('keep','u','reel','["x"]','2030-01-01T00:00:00Z','cap','posted','pub1')`).run();
  assert.match(last, /^0025_/, 'the story migration must be the newest');
  d.exec(fs.readFileSync(new URL(last, MIGRATIONS), 'utf8'));
  const row = d.prepare(`SELECT * FROM scheduled_posts WHERE id='keep'`).get();
  assert.deepEqual([row.caption, row.status, row.tt_publish_id, row.type], ['cap', 'posted', 'pub1', 'reel']);
});
