// cron-worker/poster.js
//
// Standalone Cloudflare WORKER (not a Pages Function) that publishes due
// Instagram posts via the Instagram Graph API. Runs on a 1-minute cron defined
// in cron-worker/wrangler.toml. Pages Functions cannot run cron, so this is a
// separate Worker deployment sharing the same D1 database.
//
// Bindings used:
//   env.DB — D1 database (scheduled_posts, ig_tokens)
//
// Media assets are fetched by Meta from the Pages site's public
// https://brandgita.com/api/media/{key} endpoint, so this Worker needs no R2 binding.
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
import { MEDIA_BASE } from './util.js';

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
async function claimPost(env, id) {
  const res = await env.DB.prepare(
    `UPDATE scheduled_posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'`
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
  } else {
    // Requeue for the next cron run.
    await env.DB.prepare(
      `UPDATE scheduled_posts SET status = 'scheduled', retry_count = ?, error = ? WHERE id = ?`
    ).bind(next, errorText, post.id).run();
    console.error(`Post ${post.id} failed (attempt ${next}), will retry: ${errorText}`);
  }
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
    await markFailed(env, post.id, err.message);
    return;
  }

  const credsResult = await adapter.loadCredentials(env, post);
  if (!credsResult.ok) {
    if (credsResult.permanent) {
      await markFailed(env, post.id, credsResult.error);
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
    await markFailed(env, post.id, `Invalid asset_keys JSON: ${err.message}`);
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
    await markFailed(env, post.id, `Unknown post type: ${post.type}`);
    return;
  }

  try {
    const { permalink } = await adapter.publish({
      post,
      assetKeys,
      creds: credsResult.creds,
      deps: { mediaBase, sleepFn, pollIntervalMs, pollMaxMs },
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
       LIMIT 10`
    ).all();
    duePosts = result.results || [];
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
}

// ---------------------------------------------------------------------------
// Cron entrypoint
// ---------------------------------------------------------------------------

// Named exports below are ONLY for cron-worker/poster.test.js (characterization
// tests written ahead of a planned restructure). The Worker runtime consumes
// nothing but `default.scheduled` — Wrangler doesn't even look at named exports
// on a scheduled handler — so these are inert in production. (refreshExpiringTokens
// is exported separately above, as a pass-through to the Instagram adapter.)
export { processPost, handleRetryableFailure, claimPost, runDue };

export default {
  async scheduled(event, env, ctx) {
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
