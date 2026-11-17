// Platform-agnostic asset records: tagging, idempotent re-upload, listing, purge. Real SQLite.
// Run: node --test shared/assets.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  validateMetadata, reserveAsset, markAssetUploaded, markAssetsPurged, listAssets, ASSET_RETENTION_DAYS,
} from './assets.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
let db; let env; let present;

function freshDb() {
  const d = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    try { d.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8')); } catch (e) { if (!/waitlist/.test(e.message)) throw e; }
  }
  return d;
}
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
beforeEach(() => {
  db = freshDb();
  present = new Set();
  env = { DB: d1(db), SCHEDULE_BUCKET: { head: async (k) => (present.has(k) ? { key: k } : null) } };
});

const meta = (over = {}) => ({ piece: 'dawn-reel', targets: ['ig', 'tiktok'], aspect: '9:16', tags: ['launch'], source_path_hash: 'h1', ...over });

// ── validateMetadata ────────────────────────────────────────────────────────
test('valid metadata passes and is normalised; every field is optional', () => {
  assert.deepEqual(validateMetadata(meta()).problems, []);
  assert.deepEqual(validateMetadata({}).problems, []);
  assert.deepEqual(validateMetadata(undefined), { value: null, problems: [] });
});

test('metadata must be an object, with typed fields', () => {
  assert.ok(validateMetadata('x').problems.length);
  assert.ok(validateMetadata(meta({ piece: 5 })).problems.some((p) => /piece/.test(p)));
  assert.ok(validateMetadata(meta({ tags: 'a' })).problems.some((p) => /tags/.test(p)));
  assert.ok(validateMetadata(meta({ tags: [1] })).problems.some((p) => /tags/.test(p)));
  assert.ok(validateMetadata(meta({ source_path_hash: '' })).problems.some((p) => /source_path_hash/.test(p)));
});

test('targets must be known platforms; the message names the allowed ones', () => {
  const p = validateMetadata(meta({ targets: ['myspace'] })).problems.join(' ');
  assert.match(p, /myspace/);
  assert.match(p, /tiktok/);
});

test('aspect must be one the system knows', () => {
  assert.ok(validateMetadata(meta({ aspect: '3:2' })).problems.some((x) => /aspect/.test(x)));
});

test('an aspect the target platform does not accept is rejected, naming platform and aspect', () => {
  const p = validateMetadata(meta({ targets: ['tiktok'], aspect: '4:5' })).problems.join(' ');
  assert.match(p, /TikTok/);
  assert.match(p, /4:5/);
  // 4:5 is fine for Instagram (carousel); 16:9 for YouTube.
  assert.deepEqual(validateMetadata(meta({ targets: ['ig'], aspect: '4:5' })).problems, []);
  assert.deepEqual(validateMetadata(meta({ targets: ['youtube'], aspect: '16:9' })).problems, []);
});

test('targets accept the canonical ids too, and are stored de-duplicated in canonical form', () => {
  const v = validateMetadata(meta({ targets: ['tiktok', 'tt', 'ig'], aspect: '9:16' }));
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.value.targets, ['tt', 'ig']);
});

// ── reserveAsset / idempotency ──────────────────────────────────────────────
test('a first upload reserves the key and is not "existing"', async () => {
  const out = await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  assert.equal(out.existing, false);
  assert.equal(out.key, 'u1/reel/a.mp4');
});

test('the same fingerprint + aspect again returns the EXISTING key when the object is still stored', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  await markAssetUploaded(env, 'u1/reel/a.mp4');
  present.add('u1/reel/a.mp4');
  const out = await reserveAsset(env, 'u1', 'u1/reel/b.mp4', validateMetadata(meta()).value);
  assert.equal(out.existing, true);
  assert.equal(out.key, 'u1/reel/a.mp4');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 1);
});

test('a different aspect for the same fingerprint is a different asset', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  await markAssetUploaded(env, 'u1/reel/a.mp4'); present.add('u1/reel/a.mp4');
  const out = await reserveAsset(env, 'u1', 'u1/reel/wide.mp4', validateMetadata(meta({ aspect: '16:9', targets: ['youtube'] })).value);
  assert.equal(out.existing, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 2);
});

test('another account never sees or reuses this account\'s asset', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  await markAssetUploaded(env, 'u1/reel/a.mp4'); present.add('u1/reel/a.mp4');
  const out = await reserveAsset(env, 'u2', 'u2/reel/a.mp4', validateMetadata(meta()).value);
  assert.equal(out.existing, false);
});

test('if the stored object has gone (lifecycle expiry), the fingerprint is re-reserved for the NEW key', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  await markAssetUploaded(env, 'u1/reel/a.mp4'); // but never added to `present`: R2 no longer has it
  const out = await reserveAsset(env, 'u1', 'u1/reel/b.mp4', validateMetadata(meta()).value);
  assert.equal(out.existing, false);
  assert.equal(out.key, 'u1/reel/b.mp4');
  const rows = db.prepare('SELECT key, uploaded_at FROM assets').all();
  assert.deepEqual(rows.map((r) => r.key), ['u1/reel/b.mp4']);
  assert.equal(rows[0].uploaded_at, null);
});

test('an asset purged by retention is not reused', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  await markAssetUploaded(env, 'u1/reel/a.mp4'); present.add('u1/reel/a.mp4');
  await markAssetsPurged(env, ['u1/reel/a.mp4']);
  const out = await reserveAsset(env, 'u1', 'u1/reel/b.mp4', validateMetadata(meta()).value);
  assert.equal(out.existing, false);
});

test('re-reserving the SAME key refreshes its tags instead of erroring', async () => {
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta()).value);
  const out = await reserveAsset(env, 'u1', 'u1/reel/a.mp4', validateMetadata(meta({ tags: ['new'] })).value);
  assert.equal(out.key, 'u1/reel/a.mp4');
  assert.deepEqual(JSON.parse(db.prepare('SELECT tags FROM assets').get().tags), ['new']);
});

test('metadata without a fingerprint never dedupes', async () => {
  const m = validateMetadata(meta({ source_path_hash: undefined })).value;
  await reserveAsset(env, 'u1', 'u1/reel/a.mp4', m);
  const out = await reserveAsset(env, 'u1', 'u1/reel/b.mp4', m);
  assert.equal(out.existing, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, 2);
});

// ── listAssets ──────────────────────────────────────────────────────────────
async function seedUploaded(key, m, user = 'u1') {
  await reserveAsset(env, user, key, validateMetadata(m).value);
  await markAssetUploaded(env, key);
}

test('list returns only uploaded, unpurged assets of the caller, with metadata decoded', async () => {
  await seedUploaded('u1/reel/a.mp4', meta());
  await reserveAsset(env, 'u1', 'u1/reel/pending.mp4', validateMetadata(meta({ source_path_hash: 'h2' })).value); // never uploaded
  await seedUploaded('u2/reel/x.mp4', meta(), 'u2');
  const out = await listAssets(env, 'u1', {});
  assert.deepEqual(out.map((a) => a.key), ['u1/reel/a.mp4']);
  assert.deepEqual(
    { piece: out[0].piece, targets: out[0].targets, aspect: out[0].aspect, tags: out[0].tags, source_path_hash: out[0].source_path_hash },
    { piece: 'dawn-reel', targets: ['ig', 'tt'], aspect: '9:16', tags: ['launch'], source_path_hash: 'h1' },
  );
  assert.ok(out[0].expires_at);
});

test('list filters by tag with an exact match (not a substring)', async () => {
  await seedUploaded('u1/reel/a.mp4', meta({ tags: ['launch'] }));
  await seedUploaded('u1/reel/b.mp4', meta({ tags: ['launch-day'], source_path_hash: 'h2' }));
  assert.deepEqual((await listAssets(env, 'u1', { tag: 'launch' })).map((a) => a.key), ['u1/reel/a.mp4']);
});

test('list filters by piece, aspect and target', async () => {
  await seedUploaded('u1/reel/a.mp4', meta());
  await seedUploaded('u1/reel/b.mp4', meta({ piece: 'other', aspect: '16:9', targets: ['youtube'], source_path_hash: 'h2' }));
  assert.deepEqual((await listAssets(env, 'u1', { piece: 'other' })).map((a) => a.key), ['u1/reel/b.mp4']);
  assert.deepEqual((await listAssets(env, 'u1', { aspect: '9:16' })).map((a) => a.key), ['u1/reel/a.mp4']);
  assert.deepEqual((await listAssets(env, 'u1', { target: 'tiktok' })).map((a) => a.key), ['u1/reel/a.mp4']);
});

test('list hides an asset older than the bucket expiry (R2 has already reaped it)', async () => {
  await seedUploaded('u1/reel/a.mp4', meta());
  db.prepare(`UPDATE assets SET uploaded_at = ?`).run(new Date(Date.now() - (ASSET_RETENTION_DAYS + 1) * 864e5).toISOString());
  assert.deepEqual(await listAssets(env, 'u1', {}), []);
});

test('markAssetsPurged hides the asset from listing', async () => {
  await seedUploaded('u1/reel/a.mp4', meta());
  await markAssetsPurged(env, ['u1/reel/a.mp4']);
  assert.deepEqual(await listAssets(env, 'u1', {}), []);
});

test('asset bookkeeping failing never throws (the file operation is the thing that matters)', async () => {
  const broken = { DB: { prepare() { throw new Error('d1 down'); } }, SCHEDULE_BUCKET: env.SCHEDULE_BUCKET };
  await markAssetUploaded(broken, 'k');
  await markAssetsPurged(broken, ['k']);
});
