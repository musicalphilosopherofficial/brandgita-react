// cron-worker/poster.js
//
// Standalone Cloudflare WORKER (not a Pages Function) that publishes due
// Instagram posts via the Instagram Graph API. Runs on a 1-minute cron defined
// in cron-worker/wrangler.toml. Pages Functions cannot run cron, so this is a
// separate Worker deployment sharing the same D1 database.
//
// Bindings used:
//   env.DB — D1 database (scheduled_posts, ig_tokens)
//   env.SCHEDULE_BUCKET — R2 bucket. NOT used by the publish path itself: Meta fetches
//     scheduled media from the Pages site's public https://brandgita.com/api/media/{key}
//     endpoint, so publishing needs no R2 access here. It's used by the daily data-retention
//     purge (../shared/data-retention.js) to delete a lapsed creator's held/missed post
//     media, and by bugdrain.js to read a bug report's screenshot bytes for Notion.
//
// Design notes:
//   - R2 objects are private and have no built-in presigned GET URL in Workers.
//     Assets are therefore served through a separate worker route. We hand the
//     Instagram API a public URL of the form https://brandgita.com/api/media/{key}
//     which the (separately implemented) media endpoint streams from R2.
//   - Every post is processed inside its own try/catch so one failure never
//     aborts the whole cron run.
//   - Failures retry (status -> 'scheduled', retry_count++) until the 5th
//     attempt, then fail permanently. Expired/invalid tokens (Meta code 190)
//     fail immediately with error 'TOKEN_EXPIRED' so the desktop app can prompt
//     a reconnect.

import { drainBugReports } from './bugdrain.js';
import { adapterFor, ADAPTERS } from './platforms/index.js';
import { DEFAULT_PLATFORM, contractFor } from '../shared/platform-contracts.js';
import { runDataRetentionPurge } from '../shared/data-retention.js';
import { purgePostedMedia } from '../shared/media-retention.js';
import { raisePostFailure } from '../shared/failure-audit.js';
import { MEDIA_BASE, countRows } from './util.js';

// Container processing poll configuration (reels are transcoded async by Meta).
// Lives here rather than in platforms/instagram.js because processPost's own
// signature (below) needs concrete numeric defaults, and that signature must
// stay stable across the platform-adapter split — see the comment above
// processPost for why.
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const POLL_MAX_MS = 5 * 60_000;  // 5 minutes

// retry_count at which the *current* attempt is the final (5th) one.
const MAX_RETRY_BEFORE_PERMANENT_FAIL = 4;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// DB state transitions
// ---------------------------------------------------------------------------

// Atomically claim a post. Returns true only if THIS run flipped it from
// 'scheduled' to 'posting'. Cron runs every minute but a slow reel can take 5+
// minutes, so runs overlap — a plain unconditional UPDATE let two ticks both
// process the same row and double-publish. The conditional WHERE + changes check
// is a compare-and-swap: only one run wins.
// The entitlement predicate, shared by the due-query and the claim CAS so the two can never
// disagree about who is allowed to publish. Fails CLOSED: a post is publishable only when its
// account resolves through ig_tokens.whop_membership_id to a whop_memberships row that is
// actively 'active'. A NULL membership link (an account connected before migration 0010 added
// the column) does NOT satisfy it — "we don't know who this is" is not permission. Reconnecting
// re-runs /api/token, which records the membership id.
const ENTITLED_SQL = `
  EXISTS (
    SELECT 1 FROM ig_tokens t
      JOIN whop_memberships m ON m.membership_id = t.whop_membership_id
     WHERE t.ig_user_id = scheduled_posts.ig_user_id
       AND m.status = 'active'
  )`;

// Atomically claim a post. Returns true only if THIS run flipped it from
// 'scheduled' to 'posting'. Cron runs every minute but a slow reel can take 5+
// minutes, so runs overlap — a plain unconditional UPDATE let two ticks both
// process the same row and double-publish. The conditional WHERE + changes check
// is a compare-and-swap: only one run wins.
//
// The CAS also re-checks entitlement, and that is not belt-and-braces: a membership can lapse
// in the window between the due-query selecting a row and this claim, and a slow reel keeps
// that window open for minutes. Checking only at query time would publish for a member who
// cancelled seconds ago.
async function claimPost(env, id) {
  const res = await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'posting', posting_since = datetime('now')
      WHERE id = ? AND status = 'scheduled' AND ${ENTITLED_SQL}`
  ).bind(id).run();
  return res?.meta?.changes === 1;
}

async function markPosted(env, id, permalink) {
  await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'posted', permalink = ?, error = NULL WHERE id = ?`
  ).bind(permalink || null, id).run();
}

// Permanent failure — will not be retried.
async function markFailed(env, id, errorText) {
  await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?`
  ).bind(errorText, id).run();
}

// Permanent failure that the founder must see: records it, then raises it into the bug_reports
// queue (Notion page + GitHub issue via the drain). Never throws — raisePostFailure swallows its
// own errors. Token expiry deliberately does NOT use this: it is a creator-actionable state the
// desktop already surfaces, not a fault to ticket.
async function failPermanently(env, post, errorText) {
  await markFailed(env, post.id, errorText);
  await raisePostFailure(env, post, errorText);
}

// Remember that Instagram has published this post. Best-effort by design: the post is already
// live, and a bookkeeping write must never turn that into a failure.
async function saveMediaId(env, postId, mediaId) {
  try {
    await env.DB.prepare(`UPDATE scheduled_posts SET ig_media_id = ? WHERE id = ?`).bind(mediaId, postId).run();
  } catch (err) {
    console.error(`Post ${postId}: could not save ig_media_id ${mediaId}:`, { message: err?.message });
  }
}

// Transient failure — increment retry_count and requeue (or permanently fail on
// the final attempt). `currentRetryCount` is the value read from the row BEFORE
// this attempt.
async function handleRetryableFailure(env, post, errorText) {
  const current = post.retry_count ?? 0;
  const next = current + 1;

  if (current >= MAX_RETRY_BEFORE_PERMANENT_FAIL) {
    // This was the 5th attempt (retry_count 4 -> 5). Give up permanently.
    await env.DB.prepare(
      `UPDATE scheduled_posts SET status = 'failed', retry_count = ?, error = ? WHERE id = ?`
    ).bind(next, errorText, post.id).run();
    console.error(`Post ${post.id} permanently failed after ${next} attempts: ${errorText}`);
    await raisePostFailure(env, { ...post, retry_count: next }, errorText);
  } else {
    // Requeue for the next cron run.
    await env.DB.prepare(
      `UPDATE scheduled_posts SET status = 'scheduled', retry_count = ?, error = ? WHERE id = ?`
    ).bind(next, errorText, post.id).run();
    console.error(`Post ${post.id} failed (attempt ${next}), will retry: ${errorText}`);
  }
}

// ---------------------------------------------------------------------------
// Stale-claim reaper + late-row audit — platform-agnostic, so every adapter gets both for free.
//
// Observed 2026-10-09: a reel due 12:00 sat in 'posting' for 4.5+ hours, no error, no media id.
// claimPost flips scheduled -> posting and runDue only selects 'scheduled', so a worker that died
// mid-attempt (timeout, deploy, isolate eviction) left the row there forever: the code that would
// have retried it (handleRetryableFailure) was the code that died.
//
// SELF-HEALING, NOT ALERTING (founder, 2026-10-09). The worker deals with the post itself: the reaper
// requeues it and the existing retry cap handles the rest, so a late post with retries left publishes
// on the next cron run however late. Nothing here notifies anyone and lateness never raises a ticket;
// raisePostFailure stays reserved for the existing permanent failure after the 5th attempt. The record
// is a structured console.error line, written EVERY time (no de-duplication) — Cloudflare logs are the
// audit trail.
// ---------------------------------------------------------------------------

// A claim older than this belongs to a worker that is gone. Comfortably above a slow reel (the
// container poll alone allows 5 minutes) so a live attempt is never double-claimed.
const STALE_CLAIM_MINUTES = 10;
// A still-live row (scheduled/posting) this far past its post_at is logged as late.
const LATE_ROW_MINUTES = 15;
// Bounds the late-row log so a failed row from months ago is not logged on every tick forever.
const LATE_LOOKBACK_DAYS = 7;

const STALE_CLAIM_SQL = `status = 'posting'
  AND (posting_since IS NULL OR datetime(posting_since) < datetime('now', '-${STALE_CLAIM_MINUTES} minutes'))`;

function minutesLate(post) {
  return Math.round((Date.now() - Date.parse(post.post_at)) / 60_000);
}

// One structured line, always JSON on a single line so a log search can filter on `event`.
function auditLog(event, post, statusBefore, retryCount, action) {
  console.error(JSON.stringify({
    event,
    post_id: post.id,
    platform: post.platform || DEFAULT_PLATFORM,
    status_before: statusBefore,
    minutes_late: minutesLate(post),
    retry_count: retryCount,
    action,
  }));
}

// Hand every abandoned claim back to the queue. Never throws: it runs at the top of runDue and a
// failure here must not stop publishing.
async function reapStaleClaims(env) {
  let rows = [];
  try {
    const r = await env.DB.prepare(`SELECT * FROM scheduled_posts WHERE ${STALE_CLAIM_SQL} LIMIT 50`).all();
    rows = (r.results || []).filter((p) => p.status === 'posting');
  } catch (err) {
    console.error('Poster: stale-claim query failed:', { message: err?.message });
    return 0;
  }

  let reaped = 0;
  for (const post of rows) {
    try {
      // Take ownership by refreshing the claim. If another run reaped it first (or the worker finished
      // after all), the row no longer matches and we leave it alone.
      const own = await env.DB.prepare(
        `UPDATE scheduled_posts SET posting_since = datetime('now') WHERE id = ? AND ${STALE_CLAIM_SQL}`
      ).bind(post.id).run();
      if (own?.meta?.changes !== 1) continue;

      const adapter = ADAPTERS[post.platform || DEFAULT_PLATFORM];
      const publishedId = adapter?.publishedIdColumn ? post[adapter.publishedIdColumn] : null;
      const current = post.retry_count ?? 0;
      const lastAttempt = current >= MAX_RETRY_BEFORE_PERMANENT_FAIL;

      if (publishedId) {
        // Already live on the platform. Requeue WITHOUT counting an attempt: the retry will only fetch
        // the link, and counting it here could eventually fail a post that is already published.
        await env.DB.prepare(
          `UPDATE scheduled_posts SET status = 'scheduled', posting_since = NULL, error = ?
            WHERE id = ? AND status = 'posting'`
        ).bind(`abandoned after publish (worker died); fetching link, retry ${current}`, post.id).run();
        auditLog('poster.stale_claim_reaped', post, 'posting', current, 'permalink-only retry');
      } else {
        await handleRetryableFailure(env, post, `attempt abandoned (worker died), retry ${current + 1} of ${MAX_RETRY_BEFORE_PERMANENT_FAIL + 1}`);
        auditLog('poster.stale_claim_reaped', post, 'posting', current + 1, lastAttempt ? 'failed permanently' : 'requeued');
      }
      reaped++;
    } catch (err) {
      console.error(`Poster: could not reap post ${post.id}:`, { message: err?.message });
    }
  }
  return reaped;
}

// The audit half: every still-live row (scheduled or posting) more than 15 minutes past its time
// gets a log line on every run. Failed rows are deliberately NOT here: a post that failed after its
// 5th attempt is already logged once by the reaper (or ticketed by raisePostFailure), and repeating it
// every minute for the whole lookback would bury the lines that matter. Observation only — it changes nothing. Runs AFTER the due loop so a
// post that was merely late and published in this very run is not reported as still late.
async function logLateRows(env) {
  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM scheduled_posts
        WHERE status IN ('scheduled', 'posting')
          AND datetime(post_at) < datetime('now', '-${LATE_ROW_MINUTES} minutes')
          AND datetime(post_at) > datetime('now', '-${LATE_LOOKBACK_DAYS} days')
        LIMIT 50`
    ).all();
    rows = (r.results || []).filter((p) => p.status === 'scheduled' || p.status === 'posting');
  } catch (err) {
    console.error('Poster: late-row query failed:', { message: err?.message });
    return 0;
  }
  for (const post of rows) {
    const action = post.status === 'scheduled' ? 'queued' : 'in progress';
    auditLog('poster.late_row', post, post.status, post.retry_count ?? 0, action);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Per-post orchestration — platform-agnostic dispatcher.
//
// mediaBase/sleepFn/pollIntervalMs/pollMaxMs are parameters (default = today's
// real values) purely so characterization tests (cron-worker/poster.test.js)
// can inject a fake media host, a zero-delay sleep, and a short poll deadline.
// The deadline must be injectable separately from sleepFn: a poll loop's
// `while (Date.now() < deadline)` check is real wall-clock time regardless of
// whether sleepFn is instant, so a timeout test with only sleepFn faked would
// still burn 5 real minutes spinning on Date.now(). Production callers never
// pass any of these — default parameters preserve today's behaviour exactly.
// This function packages them into a single `deps` object before handing them
// to an adapter's publish(), rather than adding a 5th/6th positional param to
// this signature every time a new platform needs a new injectable.
// ---------------------------------------------------------------------------

async function processPost(
  env, post,
  mediaBase = MEDIA_BASE, sleepFn = sleep, pollIntervalMs = POLL_INTERVAL_MS, pollMaxMs = POLL_MAX_MS
) {
  // Atomically claim the post. If another overlapping run already claimed it,
  // bail out immediately — do NOT publish (prevents double-posting).
  const won = await claimPost(env, post.id);
  if (!won) return;

  // Belt-and-braces on top of the DB DEFAULT (migration 0012 defaults every
  // row's `platform` column to 'ig'): a null/undefined value reaching
  // adapterFor() would permanently fail a real customer's post over a schema
  // technicality, not an actual unknown platform.
  const platform = post.platform || DEFAULT_PLATFORM;

  let adapter;
  try {
    adapter = adapterFor(platform);
  } catch (err) {
    // Unknown platform — not retryable, there is no adapter to retry with.
    console.error(`Post ${post.id} [platform=${platform}] unknown platform:`, err.message);
    await failPermanently(env, post, err.message);
    return;
  }

  const credsResult = await adapter.loadCredentials(env, post);
  if (!credsResult.ok) {
    if (credsResult.permanent) {
      await failPermanently(env, post, credsResult.error);
    } else {
      await handleRetryableFailure(env, post, credsResult.error);
    }
    return;
  }

  // Parse the JSON array of R2 keys.
  let assetKeys;
  try {
    assetKeys = JSON.parse(post.asset_keys);
    if (!Array.isArray(assetKeys)) throw new Error('asset_keys is not an array');
  } catch (err) {
    await failPermanently(env, post, `Invalid asset_keys JSON: ${err.message}`);
    return;
  }

  // Content-type validity is a platform fact, already checked once at create
  // time (functions/api/schedule.js, via this SAME contract) — this is a
  // defensive re-check at publish time for a row that predates that
  // validation or was altered at rest. Reading from the identical contract
  // rather than a separately-maintained list means the two checks cannot
  // silently drift apart.
  const contract = contractFor(platform);
  if (!contract.contentTypes.includes(post.type)) {
    // Unknown type — not retryable.
    await failPermanently(env, post, `Unknown post type: ${post.type}`);
    return;
  }

  try {
    const { permalink } = await adapter.publish({
      post,
      assetKeys,
      creds: credsResult.creds,
      deps: { mediaBase, sleepFn, pollIntervalMs, pollMaxMs, onMediaPublished: (mediaId) => saveMediaId(env, post.id, mediaId) },
    });

    await markPosted(env, post.id, permalink);
    console.log(`Post ${post.id} [platform=${platform}] published: ${permalink}`);
  } catch (err) {
    // Auth expired/invalid — fail permanently with the sentinel the desktop
    // app polls for, regardless of retry_count. The literal string
    // 'TOKEN_EXPIRED' is fixed here and must never change; only WHICH errors
    // trigger it is generalised, behind adapter.isAuthExpired().
    if (adapter.isAuthExpired(err)) {
      await markFailed(env, post.id, 'TOKEN_EXPIRED');
      console.error(`Post ${post.id} [platform=${platform}] failed: auth expired`);
      return;
    }

    // Any other error is treated as transient -> retry up to the cap.
    const message = (err && err.message) ? err.message : String(err);
    await handleRetryableFailure(env, post, message.slice(0, 1000));
  }
}

// Back-compat named export: cron-worker/poster.test.js's characterization
// suite (written before the platform-adapter split, kept byte-for-byte
// unchanged through it as proof the refactor is behaviour-preserving) imports
// `refreshExpiringTokens` directly from this module. The real implementation
// now lives on the Instagram adapter (platforms/instagram.js) — this is a
// thin pass-through so that test file's import surface needed zero edits.
export const refreshExpiringTokens = (env) => ADAPTERS.ig.refreshExpiringTokens(env);

// ---------------------------------------------------------------------------
// Due-post batch — find due posts, process each in isolation.
//
// Extracted out of the cron entrypoint (was inline in `scheduled()`) so it can
// be tested directly, and so a future per-platform loop (each platform's own
// due-query + processor) can wrap this without duplicating the query/loop
// logic. `deps` carries the same test-only injection points as processPost —
// production's only caller (`scheduled()` below) always passes `{}`, so every
// default here is today's real behaviour.
// ---------------------------------------------------------------------------
async function runDue(env, deps = {}) {
  const {
    mediaBase = MEDIA_BASE,
    sleepFn = sleep,
    pollIntervalMs = POLL_INTERVAL_MS,
    pollMaxMs = POLL_MAX_MS,
  } = deps;

  // First hand back any claim whose worker died, so it is eligible for the due-query below.
  await reapStaleClaims(env);

  // Find up to 10 due, still-scheduled posts under the retry cap.
  let duePosts = [];
  try {
    // CRITICAL FIX 2026-08-30: post_at is stored verbatim as whatever ISO 8601 string the
    // client sent (schedule.js never normalizes it) — a real client sends
    // "2026-08-30T12:00:00.000Z" (Date#toISOString()'s format), while SQLite's own
    // datetime('now') returns "2026-08-30 12:00:00" (space separator, no ms, no Z). A bare
    // `post_at <= datetime('now')` is a lexicographic STRING comparison: 'T' (0x54) sorts
    // AFTER ' ' (0x20), so ANY real ISO post_at compares as "later" than now regardless of
    // the actual timestamps — proved directly: a post_at one hour in the PAST evaluated as
    // NOT due. This meant no scheduled post could ever have fired through this query.
    // datetime(post_at) parses the ISO string into SQLite's own comparable format first.
    const result = await env.DB.prepare(
      `SELECT * FROM scheduled_posts
       WHERE datetime(post_at) <= datetime('now')
         AND status = 'scheduled'
         AND retry_count < 5
         AND ${ENTITLED_SQL}
       LIMIT 10`
    ).all();
    duePosts = result.results || [];
    // Log matched-of-eligible on EVERY run, not just on error. 59bbbcc's signature was
    // an ABSENCE of posts with no thrown error — the query ran "successfully" and
    // matched nothing, forever. The matched count ALONE cannot see that: "matched 0"
    // is what an empty queue looks like too. The denominator is the set the
    // datetime() filter selects FROM (same status/retry_count predicates, no time
    // comparison), so a persistent `matched 0 of 7` is the bug, unambiguously — and
    // `matched 10 of 47` says the backlog exceeds what one LIMIT 10 run can drain.
    const eligible = await countRows(
      env,
      `SELECT COUNT(*) AS n FROM scheduled_posts
        WHERE status = 'scheduled' AND retry_count < 5`
    );
    console.log(`Poster: due-post query matched ${duePosts.length} of ${eligible ?? '?'} eligible row(s)`);
  } catch (err) {
    console.error('Poster: failed to query due posts:', err);
    // Swallow it here (duePosts stays []) rather than rethrow — the caller
    // (scheduled()) runs the token-refresh pass unconditionally right after
    // this returns, and a broken due-query must not skip that.
  }

  // Process each post in isolation; one failure must not abort the run.
  for (const post of duePosts) {
    try {
      await processPost(env, post, mediaBase, sleepFn, pollIntervalMs, pollMaxMs);
    } catch (err) {
      // Defensive catch — processPost handles its own errors, but if state
      // transition writes themselves throw, capture it here so the loop
      // continues with the next post.
      console.error(`Poster: unhandled error processing post ${post.id}:`, err);
      try {
        await handleRetryableFailure(env, post, `Unhandled: ${err.message || err}`);
      } catch (innerErr) {
        console.error(`Poster: failed to record failure for post ${post.id}:`, innerErr);
      }
    }
  }

  // Last: log anything still unpublished 15+ minutes past its time (observation only).
  await logLateRows(env);
}

// ---------------------------------------------------------------------------
// Cron entrypoint
// ---------------------------------------------------------------------------

// Named exports below are ONLY for cron-worker/poster.test.js (characterization
// tests written ahead of a planned restructure). The Worker runtime consumes
// nothing but `default.scheduled` — Wrangler doesn't even look at named exports
// on a scheduled handler — so these are inert in production. (refreshExpiringTokens
// is exported separately above, as a pass-through to the Instagram adapter.)
export { processPost, handleRetryableFailure, claimPost, runDue, reapStaleClaims, logLateRows };

export default {
  async scheduled(event, env, ctx) {
    // The daily retention purge is its own cron trigger (0 3 * * *, see wrangler.toml) so
    // it runs once a day rather than on every minute tick — D1 bills per row read, and the
    // query in findLapsedMemberships has no reason to run 1,440 times for a 24-hour answer.
    // Isolated in its own try/catch for the same reason bugdrain and token-refresh below
    // are: a purge failure must never be allowed to look like a reason to skip publishing.
    if (event.cron === '0 3 * * *') {
      try {
        const purged = await runDataRetentionPurge(env);
        if (purged.length) console.log('data-retention', JSON.stringify(purged));
      } catch (err) {
        console.error('data-retention: unhandled', { message: err?.message });
      }
      // Posted media is deleted 7 days after it posts. Its own try/catch for the same reason as
      // above: one purge failing must never stop the other.
      try {
        const media = await purgePostedMedia(env);
        if (media.purged || media.failed) console.log('media-retention', JSON.stringify(media));
      } catch (err) {
        console.error('media-retention: unhandled', { message: err?.message });
      }
      return;
    }

    await runDue(env, {});

    // Drain queued bug reports into GitHub/Notion. Isolated in its own try/catch for
    // the same reason as the per-platform sweeps below: a tracker outage must not stop
    // scheduled posts from going out. Publishing is the creator's livelihood; filing a
    // ticket can wait for the next tick.
    try {
      const r = await drainBugReports(env);
      if (r && (r.synced || r.failed)) {
        console.log('bugdrain', JSON.stringify(r));
      }
    } catch (err) {
      console.error('bugdrain: unhandled', { message: err?.message });
    }

    // Refresh credentials for every registered platform that defines a sweep.
    // Each platform's refresh is individually try/caught so one platform's
    // failure can't touch another's — the same isolation principle as the
    // per-post loop in runDue. This runs unconditionally after runDue, even
    // if runDue's due-posts query itself failed (see the comment inside
    // runDue: it swallows that error rather than rethrow it here).
    for (const adapter of Object.values(ADAPTERS)) {
      // refreshExpiringTokens is OPTIONAL on the adapter contract: Instagram's
      // long-lived token needs a periodic sweep before it expires, but a
      // platform whose model is lazy refresh-at-publish-time (nothing to
      // sweep ahead of time) should simply not implement this method, rather
      // than carry a no-op stub.
      if (typeof adapter.refreshExpiringTokens !== 'function') continue;
      try {
        await adapter.refreshExpiringTokens(env);
      } catch (err) {
        console.error(`Poster: token refresh pass failed for platform=${adapter.id}:`, err);
      }
    }
  },
};
