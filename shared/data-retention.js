/**
 * Cloud data retention after a subscription lapses.
 *
 * THE RULE, decided by the founder 2026-09-19: 15 days after a Whop membership goes
 * inactive, purge everything that isn't needed to prove the relationship existed.
 *
 * WHY 15 DAYS. Long enough that the commonest lapse cause — a bounced card — has a real
 * window to get fixed without losing anything; this is deliberately much longer than
 * entitlement-hold.js's 6-hour grace, because that one is about a single post's timing and
 * this one is about giving a paying customer time to update a card.
 *
 * WHAT'S DELETED, and why each is safe:
 *
 *   ig_tokens        the live Instagram access_token. Dead weight after 15 days — Meta's
 *                    long-lived tokens expire on their own well inside that window, and a
 *                    returning creator goes through OAuth again regardless of whether we
 *                    kept the old one.
 *
 *   scheduled_posts  only rows already 'held_entitlement' or 'missed' — see
 *   (+ R2 objects)   entitlement-hold.js. A post that fired before the lapse is untouched.
 *                    Their R2 media is deleted with them; nothing else references those keys
 *                    once the row is gone.
 *
 *   brand_kits       the CLOUD copy only. migrations/0014_brand_kits.sql made
 *                    ~/.bg/brand-gitas the creator's own complete working copy, not a
 *                    read-through cache — and electron-shell/kit-sync.js's decideSync()
 *                    returns PUSH the instant it sees local-with-no-remote, so reconnecting
 *                    after this purge re-uploads the kit automatically. Keeping the cloud
 *                    copy after the local copy already guarantees no work is lost bought
 *                    nothing but indefinite retention of a creator's brand IP and voice
 *                    profile after they stopped paying for it to be stored.
 *
 * WHAT SURVIVES, and why:
 *
 *   whop_memberships kept forever as the billing audit trail (unchanged since migration
 *                    0009) — but its `email` is scrubbed at the same 15-day mark. The audit
 *                    trail only needs to prove a membership existed and changed state, not
 *                    who it belonged to.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. `purged_at` (migration 0017) marks a membership done; the
 * query only ever selects rows where it is still null, so a retry after a partial failure —
 * an R2 delete that threw, a worker that got evicted mid-run — simply finishes what is left
 * without re-processing anything already cleaned up.
 */

export const GRACE_DAYS = 15;
export const GRACE_SQL_MODIFIER = `-${GRACE_DAYS} days`;

/** Memberships past the grace window that have not yet been purged. */
export async function findLapsedMemberships(env) {
  const res = await env.DB.prepare(
    `SELECT membership_id FROM whop_memberships
      WHERE status = 'inactive'
        AND updated_at <= datetime('now', ?)
        AND purged_at IS NULL`
  ).bind(GRACE_SQL_MODIFIER).all();
  return (res?.results ?? []).map((r) => r.membership_id);
}

/**
 * Purge everything for one lapsed membership. Each sub-step is isolated so an R2 failure
 * cannot leave ig_tokens or brand_kits un-purged, or vice versa — the caller logs whatever
 * this returns and moves on; a future run picks up anything an R2 error left behind, since
 * only the final whop_memberships write (which never touches R2) marks the row done.
 */
export async function purgeMembership(env, membershipId) {
  const result = {
    membershipId, igTokens: 0, scheduledPosts: 0, r2Objects: 0, r2Errors: 0, brandKits: 0,
  };

  const { results: tokenRows } = await env.DB.prepare(
    `SELECT ig_user_id FROM ig_tokens WHERE whop_membership_id = ?`
  ).bind(membershipId).all();
  const igUserIds = (tokenRows ?? []).map((r) => r.ig_user_id);

  for (const igUserId of igUserIds) {
    const { results: posts } = await env.DB.prepare(
      `SELECT id, asset_keys, cover_key FROM scheduled_posts
        WHERE ig_user_id = ? AND status IN ('held_entitlement', 'missed')`
    ).bind(igUserId).all();

    for (const post of posts ?? []) {
      let keys = [];
      try {
        keys = JSON.parse(post.asset_keys || '[]');
      } catch {
        // Malformed stored JSON — nothing to key off for this post; the row delete below
        // still removes it. Same posture as schedule/[id].js's DELETE handler.
        console.error(`data-retention: malformed asset_keys for post ${post.id}`);
      }
      if (post.cover_key) keys.push(post.cover_key);

      for (const key of keys) {
        try {
          await env.SCHEDULE_BUCKET.delete(key);
          result.r2Objects += 1;
        } catch (err) {
          console.error(`data-retention: R2 delete failed for key '${key}':`, { message: err?.message });
          result.r2Errors += 1;
        }
      }
    }

    const del = await env.DB.prepare(
      `DELETE FROM scheduled_posts WHERE ig_user_id = ? AND status IN ('held_entitlement', 'missed')`
    ).bind(igUserId).run();
    result.scheduledPosts += del?.meta?.changes ?? 0;
  }

  const tokDel = await env.DB.prepare(
    `DELETE FROM ig_tokens WHERE whop_membership_id = ?`
  ).bind(membershipId).run();
  result.igTokens = tokDel?.meta?.changes ?? 0;

  const kitDel = await env.DB.prepare(
    `DELETE FROM brand_kits WHERE membership_id = ?`
  ).bind(membershipId).run();
  result.brandKits = kitDel?.meta?.changes ?? 0;

  // Last, and never skipped by an earlier throw in this function (each step above is its
  // own statement, not wrapped in a try that would swallow into here) — this is the write
  // that marks the membership done, so it must reflect a purge that actually happened.
  await env.DB.prepare(
    `UPDATE whop_memberships SET email = NULL, purged_at = datetime('now') WHERE membership_id = ?`
  ).bind(membershipId).run();

  return result;
}

/**
 * Cron entrypoint: find every membership past the 15-day grace and purge it. One
 * membership's failure is logged and skipped, never allowed to block the rest — the same
 * per-item isolation principle as poster.js's per-post loop.
 */
export async function runDataRetentionPurge(env) {
  const membershipIds = await findLapsedMemberships(env);
  const results = [];
  for (const membershipId of membershipIds) {
    try {
      results.push(await purgeMembership(env, membershipId));
    } catch (err) {
      console.error(`data-retention: purge failed for membership ${membershipId}:`, { message: err?.message });
    }
  }
  return results;
}
