/**
 * Assets — stored files, described independently of any platform.
 *
 * Founder, 2026-11-12: the footage is decoupled from the platforms. A file is uploaded ONCE and
 * tagged with where it may go (`targets`), what shape it is (`aspect`) and free-form `tags`; a later
 * schedule or post reads those tags instead of the app re-sending bytes. A platform never owns a
 * copy: it attaches to an asset through shared/media-specs.js (what it accepts), its contract (what
 * a post must look like) and its adapter (how to publish). Adding a platform adds entries to those
 * registries — it does not touch stored files or this module.
 *
 * IDEMPOTENCY. `source_path_hash` + `aspect` identify a clip for one account. Asking to store the
 * same pair again returns the existing key, but only while the object is genuinely still in R2: the
 * bucket expires objects (ASSET_RETENTION_DAYS) and retention deletes posted media, and handing back
 * a key whose bytes are gone would fail a later post. When the object is gone the fingerprint is
 * re-reserved for the new key. The hash is whatever the client sends — hash the CONTENT (or path +
 * size + mtime), not the path alone, or a re-exported file at the same path is mistaken for the old one.
 *
 * Bookkeeping here never throws into a file operation: an upload that worked must not fail because
 * a tag could not be saved. Reads of the table that decide dedupe do throw — reuse on a guess would
 * be worse than a visible error.
 */
import { MEDIA_SPECS, KNOWN_ASPECTS, PLATFORM_LABELS, canonicalPlatform, platformAcceptsAspect } from './media-specs.js';

// The bucket's lifecycle rule deletes each object this many days after upload (see schedule.js).
export const ASSET_RETENTION_DAYS = 75;

const MAX_TAGS = 20;
const MAX_TEXT = 200;
const MAX_HASH = 128;

const isNonEmptyString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Validate the optional `metadata` of an upload.
 * @returns {{value: object|null, problems: string[]}} value is the normalised record (canonical platform
 *   ids, de-duplicated targets), null when no metadata was sent.
 */
export function validateMetadata(input) {
  if (input === undefined || input === null) return { value: null, problems: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { value: null, problems: ['metadata must be an object'] };
  }
  const problems = [];
  const value = { piece: null, targets: [], aspect: null, tags: [], source_path_hash: null };

  if (input.piece !== undefined) {
    if (isNonEmptyString(input.piece, MAX_TEXT)) value.piece = input.piece;
    else problems.push(`metadata.piece must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  if (input.source_path_hash !== undefined) {
    if (isNonEmptyString(input.source_path_hash, MAX_HASH)) value.source_path_hash = input.source_path_hash;
    else problems.push(`metadata.source_path_hash must be a non-empty string of at most ${MAX_HASH} characters`);
  }
  if (input.aspect !== undefined) {
    if (KNOWN_ASPECTS.includes(input.aspect)) value.aspect = input.aspect;
    else problems.push(`metadata.aspect must be one of: ${KNOWN_ASPECTS.join(', ')} (got ${JSON.stringify(input.aspect)})`);
  }
  if (input.tags !== undefined) {
    if (Array.isArray(input.tags) && input.tags.length <= MAX_TAGS && input.tags.every((t) => isNonEmptyString(t, 50))) {
      value.tags = [...new Set(input.tags)];
    } else {
      problems.push(`metadata.tags must be a list of at most ${MAX_TAGS} non-empty strings (50 characters each)`);
    }
  }
  if (input.targets !== undefined) {
    if (!Array.isArray(input.targets)) {
      problems.push('metadata.targets must be a list');
    } else {
      const seen = new Set();
      for (const raw of input.targets) {
        const id = typeof raw === 'string' ? canonicalPlatform(raw) : null;
        if (!id || !MEDIA_SPECS[id]) {
          problems.push(`metadata.targets: unknown platform ${JSON.stringify(raw)}. Supported: tiktok, ig, youtube`);
        } else if (!seen.has(id)) {
          seen.add(id);
          value.targets.push(id);
        }
      }
    }
  }
  // Cross-check: a file tagged for a platform must be an aspect that platform accepts.
  if (value.aspect) {
    for (const id of value.targets) {
      if (!platformAcceptsAspect(id, value.aspect)) {
        problems.push(`${PLATFORM_LABELS[id] || id} does not take ${value.aspect} (it accepts ${[...new Set(Object.values(MEDIA_SPECS[id]).flatMap((s) => s.aspects))].join(' or ')})`);
      }
    }
  }
  return { value: problems.length ? null : value, problems };
}

const nowIso = () => new Date().toISOString();

/**
 * Record `key` as an asset of `userId` with `meta` (from validateMetadata). If the same fingerprint +
 * aspect already names a stored, unpurged object, return that instead of reserving a second copy.
 * @returns {{existing: boolean, key: string}}
 */
export async function reserveAsset(env, userId, key, meta) {
  const m = meta || { piece: null, targets: [], aspect: null, tags: [], source_path_hash: null };
  const hasFingerprint = Boolean(m.source_path_hash && m.aspect);

  if (hasFingerprint) {
    const row = await env.DB.prepare(
      `SELECT key, uploaded_at, purged_at FROM assets
        WHERE ig_user_id = ? AND source_path_hash = ? AND aspect = ?`
    ).bind(userId, m.source_path_hash, m.aspect).first();
    if (row) {
      if (row.key === key) {
        await refresh(env, key, m);
        return { existing: false, key };
      }
      const live = row.uploaded_at && !row.purged_at && (await env.SCHEDULE_BUCKET.head(row.key));
      if (live) {
        await refresh(env, row.key, m);
        return { existing: true, key: row.key };
      }
      // Gone (expired / purged / never finished): release the fingerprint for the new key.
      await env.DB.prepare(`DELETE FROM assets WHERE key = ?`).bind(row.key).run();
    }
  }

  await env.DB.prepare(
    `INSERT INTO assets (key, ig_user_id, piece, targets, aspect, tags, source_path_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       piece = excluded.piece, targets = excluded.targets, aspect = excluded.aspect,
       tags = excluded.tags, source_path_hash = excluded.source_path_hash,
       uploaded_at = NULL, purged_at = NULL`
  ).bind(key, userId, m.piece, JSON.stringify(m.targets), m.aspect, JSON.stringify(m.tags), m.source_path_hash, nowIso()).run();
  return { existing: false, key };
}

// Keep an existing record's tags current when the same clip is declared again.
async function refresh(env, key, m) {
  await env.DB.prepare(
    `UPDATE assets SET piece = COALESCE(?, piece), targets = ?, tags = ? WHERE key = ?`
  ).bind(m.piece, JSON.stringify(m.targets), JSON.stringify(m.tags), key).run();
}

/** The bytes are in R2. Best-effort: a tag write must never fail an upload that succeeded. */
export async function markAssetUploaded(env, key) {
  try {
    await env.DB.prepare(`UPDATE assets SET uploaded_at = ?, purged_at = NULL WHERE key = ?`).bind(nowIso(), key).run();
  } catch (err) {
    console.error('assets: could not mark uploaded', { message: err?.message });
  }
}

/** The objects are gone from R2 (retention or an unreferenced delete). Best-effort. */
export async function markAssetsPurged(env, keys) {
  for (const key of keys) {
    try {
      await env.DB.prepare(`UPDATE assets SET purged_at = ? WHERE key = ?`).bind(nowIso(), key).run();
    } catch (err) {
      console.error('assets: could not mark purged', { message: err?.message });
    }
  }
}

const decode = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };

/**
 * What the account has stored. Only assets whose bytes should still be in R2: uploaded, not purged,
 * and younger than the bucket expiry. Filters: tag (exact), piece, aspect, target (any alias).
 */
export async function listAssets(env, userId, { tag, piece, aspect, target, limit = 100 } = {}) {
  const where = [`ig_user_id = ?`, `uploaded_at IS NOT NULL`, `purged_at IS NULL`, `uploaded_at > ?`];
  const binds = [userId, new Date(Date.now() - ASSET_RETENTION_DAYS * 864e5).toISOString()];
  // Quoted-JSON instr(), not LIKE: tags may contain `_`/`%`, and 'launch' must not match 'launch-day'.
  if (tag) { where.push(`instr(tags, ?) > 0`); binds.push(JSON.stringify(tag)); }
  if (target) { where.push(`instr(targets, ?) > 0`); binds.push(JSON.stringify(canonicalPlatform(target))); }
  if (piece) { where.push(`piece = ?`); binds.push(piece); }
  if (aspect) { where.push(`aspect = ?`); binds.push(aspect); }
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT key, piece, targets, aspect, tags, source_path_hash, created_at, uploaded_at
       FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${cap}`
  ).bind(...binds).all();
  return (results || []).map((r) => ({
    key: r.key,
    piece: r.piece,
    targets: decode(r.targets),
    aspect: r.aspect,
    tags: decode(r.tags),
    source_path_hash: r.source_path_hash,
    created_at: r.created_at,
    uploaded_at: r.uploaded_at,
    expires_at: new Date(Date.parse(r.uploaded_at) + ASSET_RETENTION_DAYS * 864e5).toISOString(),
  }));
}
