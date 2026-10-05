/**
 * Posted media is deleted from R2 7 days after it posts.
 *
 * Founder, 2026-10-05: "after 7 days the posted content is deleted". The published privacy and
 * data-deletion pages promise scheduled video is held only so Instagram can fetch it, then deleted;
 * before this, nothing deleted it except a blanket 75-day bucket expiry.
 *
 * ONLY POSTED POSTS. A failed post keeps its media — it is retried and escalated to the founder
 * (shared/failure-audit.js), and deleting the video out from under that would make the retry
 * impossible. Scheduled, posting and held posts are likewise never touched.
 *
 * The clock is `post_at`, the scheduled time. The cron publishes within about a minute of it
 * (a retry adds minutes), which is negligible against 7 days and avoids a second timestamp column.
 * The cutoff is built in JS as an ISO string because post_at is stored as ISO 8601 and SQLite's
 * datetime('now') uses a different format — a bare comparison silently never matches (the
 * 2026-08-30 bug noted in cron-worker/poster.js).
 *
 * A row is marked purged only when EVERY delete succeeded, so a transient R2 failure is retried
 * on the next daily run rather than leaving media behind with the row claiming it is gone.
 */

export const MEDIA_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgePostedMedia(env, now = Date.now()) {
  const cutoff = new Date(now - MEDIA_RETENTION_DAYS * DAY_MS).toISOString();
  const out = { purged: 0, failed: 0, objects: 0 };

  let rows;
  try {
    const res = await env.DB.prepare(
      `SELECT id, asset_keys, cover_key FROM scheduled_posts
        WHERE status = 'posted' AND media_purged_at IS NULL AND post_at <= ?
        LIMIT 200`
    ).bind(cutoff).all();
    rows = res?.results ?? [];
  } catch (err) {
    console.error('media-retention: could not list posts to purge', { message: err?.message });
    return out;
  }

  for (const row of rows) {
    let keys = [];
    try {
      keys = JSON.parse(row.asset_keys || '[]');
      if (!Array.isArray(keys)) keys = [];
    } catch {
      console.error(`media-retention: malformed asset_keys for post ${row.id}`);
    }
    if (row.cover_key) keys.push(row.cover_key);

    let ok = true;
    for (const key of keys) {
      try {
        await env.SCHEDULE_BUCKET.delete(key);
        out.objects += 1;
      } catch (err) {
        ok = false;
        console.error(`media-retention: R2 delete failed for '${key}':`, { message: err?.message });
      }
    }
    if (!ok) { out.failed += 1; continue; }

    try {
      await env.DB.prepare(`UPDATE scheduled_posts SET media_purged_at = ? WHERE id = ?`)
        .bind(new Date(now).toISOString(), row.id).run();
      out.purged += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`media-retention: could not mark post ${row.id} purged`, { message: err?.message });
    }
  }
  return out;
}
