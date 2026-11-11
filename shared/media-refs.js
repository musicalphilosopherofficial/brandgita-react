/**
 * Reference-safe media deletion.
 *
 * One stored clip may be listed by several scheduled posts (one upload, many platforms — see
 * shared/media-specs.js). Every place that used to `bucket.delete(key)` on the strength of ONE
 * post going away now asks first whether another post still needs the object, because deleting it
 * would turn a different post's publish into a 404 for a creator who did nothing wrong.
 *
 * FAIL-SAFE DIRECTION: if the lookup itself fails, the object is KEPT. An orphaned file costs
 * pennies and the 75-day bucket expiry reaps it; a deleted-but-needed file fails a post.
 *
 * "Referenced" means another row, not yet purged, that lists the key in asset_keys or uses it as
 * its cover. Purged rows (media_purged_at set) have already let go of their media.
 *
 * The match is on the quoted JSON form ("key") via instr(), NOT LIKE: keys contain `_`, which LIKE
 * treats as a wildcard, and a bare substring would let `x.mp4` match `x.mp4.bak.mp4`.
 */
export async function isKeyReferencedElsewhere(env, key, excludePostId) {
  const row = await env.DB.prepare(
    `SELECT 1 AS n FROM scheduled_posts
      WHERE id != ? AND media_purged_at IS NULL
        AND (cover_key = ? OR instr(asset_keys, ?) > 0)
      LIMIT 1`
  ).bind(excludePostId ?? '', key, JSON.stringify(key)).first();
  return Boolean(row);
}

/**
 * Delete each key from R2 unless another post still references it.
 * @returns {{deleted: string[], kept: string[], failed: string[]}}
 *   `failed` = R2 refused the delete (caller may retry). `kept` is NOT a failure.
 */
export async function deleteUnreferencedMedia(env, keys, { excludePostId } = {}) {
  const out = { deleted: [], kept: [], failed: [] };
  for (const key of keys) {
    let referenced;
    try {
      referenced = await isKeyReferencedElsewhere(env, key, excludePostId);
    } catch (err) {
      console.error(`media-refs: reference lookup failed for '${key}', keeping it:`, { message: err?.message });
      out.kept.push(key);
      continue;
    }
    if (referenced) { out.kept.push(key); continue; }
    try {
      await env.SCHEDULE_BUCKET.delete(key);
      out.deleted.push(key);
    } catch (err) {
      console.error(`media-refs: R2 delete failed for '${key}':`, { message: err?.message });
      out.failed.push(key);
    }
  }
  return out;
}
