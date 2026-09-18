/**
 * What happens to a creator's queued posts while their subscription is lapsed, and what
 * happens to them when they pay.
 *
 * THE RULE, decided by the founder 2026-09-19:
 *
 *   lapse     every 'scheduled' post for that membership is PARKED as 'held_entitlement'.
 *             Not 'failed' — the commonest cause of a lapse is a card that bounced, and
 *             telling a customer their posts failed when they need to update a card is a
 *             lie that costs more than the posts did. Never deleted: unrecoverable, and it
 *             is the creator's work, not ours.
 *
 *   resume    on membership.activated, each held post is judged against its own slot:
 *               still in the future       -> 'scheduled', fires normally, nothing lost
 *               past, within the grace    -> 'scheduled', fires on the next tick
 *               past, beyond the grace    -> 'missed', surfaced for the creator to
 *                                            reschedule or discard
 *
 * WHY NOT JUST FIRE EVERYTHING ON RESUME. A creator who parked two weeks of content would
 * have it all publish at once the moment their payment cleared. That wrecks their posting
 * cadence and is exactly the burst shape Instagram rate-limits. The grace exists so a slot
 * missed by an hour still goes out, while one missed by days does not go out unasked.
 *
 * WHY NOT AUTO-RESCHEDULE INTO THE NEXT FREE SLOTS. Social copy is often time-referential
 * ("this week", "today I'm launching"), so a late post can be actively wrong rather than
 * merely late — and silently picking new slots rewrites the creator's editorial calendar
 * without asking. Park it, show it, let them choose.
 */

/** Hours of slack before a post that missed its slot is considered stale. */
export const HOLD_GRACE_HOURS = 6;

/** The SQLite modifier form of the same constant — the ONLY place it is turned into SQL. */
export const HOLD_GRACE_SQL_MODIFIER = `-${HOLD_GRACE_HOURS} hours`;

export const HELD = 'held_entitlement';
export const MISSED = 'missed';
export const SCHEDULED = 'scheduled';

/**
 * The resume decision for ONE post, as a pure function.
 *
 * This is the human-readable statement of the rule, and is what the Schedule screen uses to
 * explain a held post's fate before the creator pays ("this will still go out" vs "this one
 * missed its slot"). The actual transition is performed by one atomic SQL statement in
 * resumeHeldPosts() rather than a read-modify-write loop; `agreesWithSql` in the tests pins
 * the two to the same boundary so the constant above cannot drift out from under either.
 *
 * An unparseable post_at resolves to MISSED, never SCHEDULED: a row we cannot place in time
 * is a row we must not publish on a guess.
 */
export function resumeStatusFor(postAt, now = Date.now()) {
  const due = Date.parse(postAt);
  if (!Number.isFinite(due)) return MISSED;
  if (due > now) return SCHEDULED;
  return now - due <= HOLD_GRACE_HOURS * 3600_000 ? SCHEDULED : MISSED;
}

/**
 * Park every still-scheduled post belonging to a membership. Idempotent: a webhook Whop
 * redelivers re-parks nothing, because already-held rows no longer match `status='scheduled'`.
 *
 * Posts mid-flight ('posting') are deliberately NOT parked — that publish is already in
 * progress at Instagram and yanking the row would leave the two disagreeing about what
 * happened. It finishes; the next one is held.
 */
export async function holdPostsForMembership(env, membershipId) {
  const res = await env.DB.prepare(
    `UPDATE scheduled_posts
        SET status = ?, held_at = datetime('now')
      WHERE status = ?
        AND ig_user_id IN (SELECT ig_user_id FROM ig_tokens WHERE whop_membership_id = ?)`
  ).bind(HELD, SCHEDULED, membershipId).run();
  return res?.meta?.changes ?? 0;
}

/**
 * Release held posts, applying the staleness rule per row in ONE statement.
 *
 * Single statement rather than select-then-update-each: the cron reads this table every 60
 * seconds, so a read-modify-write loop leaves a window where a row is neither held nor
 * scheduled. The CASE collapses "still in the future" and "past but inside the grace" into
 * one branch — both mean "let it fire".
 */
export async function resumeHeldPosts(env, membershipId) {
  const res = await env.DB.prepare(
    `UPDATE scheduled_posts
        SET status = CASE
              WHEN datetime(post_at) > datetime('now', ?) THEN ?
              ELSE ?
            END,
            held_at = NULL
      WHERE status = ?
        AND ig_user_id IN (SELECT ig_user_id FROM ig_tokens WHERE whop_membership_id = ?)`
  ).bind(HOLD_GRACE_SQL_MODIFIER, SCHEDULED, MISSED, HELD, membershipId).run();
  return res?.meta?.changes ?? 0;
}
