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

import { encryptToken, decryptToken } from './_crypto.js';

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';
const MEDIA_BASE = 'https://brandgita.com/api/media';

// Container processing poll configuration (reels are transcoded async by Meta).
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const POLL_MAX_MS = 5 * 60_000;  // 5 minutes

// retry_count at which the *current* attempt is the final (5th) one.
const MAX_RETRY_BEFORE_PERMANENT_FAIL = 4;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function mediaUrl(key) {
  // key may contain slashes (e.g. "user123/clip.mp4"); encode each segment so
  // the path stays valid while preserving the directory structure.
  const encoded = String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${MEDIA_BASE}/${encoded}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Custom error that carries the Meta error code so the caller can detect 190.
class IgApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'IgApiError';
    this.igCode = code; // numeric Meta error code, or undefined
  }
}

// POST a form-encoded body to the Graph API and return parsed JSON.
// Throws IgApiError (with igCode) on any non-ok response or embedded error.
async function igPost(path, params, accessToken) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  }
  body.set('access_token', accessToken);

  let res;
  let data;
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    data = await res.json();
  } catch (err) {
    // Network / parse failure — log the I/O failure path and rethrow.
    console.error(`IG POST ${path} network error:`, err);
    throw new IgApiError(`Network error calling ${path}: ${err.message}`);
  }

  if (!res.ok || data?.error) {
    const code = data?.error?.code;
    const msg = data?.error?.message || `IG POST ${path} failed (HTTP ${res.status})`;
    console.error(`IG POST ${path} error:`, data);
    throw new IgApiError(msg, code);
  }
  return data;
}

// GET a Graph API resource and return parsed JSON. Same error semantics as igPost.
async function igGet(path, fields, accessToken) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', accessToken);

  let res;
  let data;
  try {
    res = await fetch(url.toString());
    data = await res.json();
  } catch (err) {
    console.error(`IG GET ${path} network error:`, err);
    throw new IgApiError(`Network error calling ${path}: ${err.message}`);
  }

  if (!res.ok || data?.error) {
    const code = data?.error?.code;
    const msg = data?.error?.message || `IG GET ${path} failed (HTTP ${res.status})`;
    console.error(`IG GET ${path} error:`, data);
    throw new IgApiError(msg, code);
  }
  return data;
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
// Instagram publish flows
// ---------------------------------------------------------------------------

// Poll a media container until it reaches FINISHED, or throw on ERROR/timeout.
async function waitForContainerReady(igUserId, creationId, accessToken) {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const statusData = await igGet(creationId, 'status_code', accessToken);
    const code = statusData.status_code;

    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new IgApiError(`Container ${creationId} processing returned status ${code}`);
    }
    // IN_PROGRESS / PUBLISHED-not-yet — keep polling.
    await sleep(POLL_INTERVAL_MS);
  }

  throw new IgApiError(`Container ${creationId} did not finish within ${POLL_MAX_MS / 1000}s`);
}

// Publish a finished container and return its permalink.
async function publishAndGetPermalink(igUserId, creationId, accessToken) {
  const publishRes = await igPost(`${igUserId}/media_publish`, { creation_id: creationId }, accessToken);
  const mediaId = publishRes.id;
  if (!mediaId) {
    throw new IgApiError(`media_publish returned no media id for container ${creationId}`);
  }

  const permaRes = await igGet(mediaId, 'permalink', accessToken);
  return permaRes.permalink || null;
}

// REEL: create container -> poll -> publish -> permalink.
async function postReel(post, assetKeys, accessToken) {
  const igUserId = post.ig_user_id;

  if (!assetKeys.length) {
    throw new IgApiError('Reel has no asset keys');
  }

  const params = {
    media_type: 'REELS',
    video_url: mediaUrl(assetKeys[0]),
    caption: post.caption || '',
  };
  // cover_url is optional — only include when a cover_key exists.
  if (post.cover_key) {
    params.cover_url = mediaUrl(post.cover_key);
  }

  const createRes = await igPost(`${igUserId}/media`, params, accessToken);
  const creationId = createRes.id;
  if (!creationId) {
    throw new IgApiError('Reel container creation returned no id');
  }

  // Reels are transcoded asynchronously; wait for FINISHED before publishing.
  await waitForContainerReady(igUserId, creationId, accessToken);

  return publishAndGetPermalink(igUserId, creationId, accessToken);
}

// CAROUSEL: create one child container per image -> create carousel container
// -> publish -> permalink.
async function postCarousel(post, assetKeys, accessToken) {
  const igUserId = post.ig_user_id;

  if (assetKeys.length < 2) {
    throw new IgApiError('Carousel requires at least 2 items');
  }

  // 1. Create a child container for each image.
  const childIds = [];
  for (const key of assetKeys) {
    const childRes = await igPost(
      `${igUserId}/media`,
      { image_url: mediaUrl(key), is_carousel_item: 'true' },
      accessToken
    );
    if (!childRes.id) {
      throw new IgApiError(`Carousel child creation returned no id for key ${key}`);
    }
    childIds.push(childRes.id);
  }

  // 2. Create the parent carousel container referencing all children.
  const carouselRes = await igPost(
    `${igUserId}/media`,
    {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: post.caption || '',
    },
    accessToken
  );
  const carouselId = carouselRes.id;
  if (!carouselId) {
    throw new IgApiError('Carousel container creation returned no id');
  }

  // 3. Publish and return the permalink. (Image carousels are typically ready
  // immediately; media_publish will surface a not-ready error if not, which is
  // retried by the outer handler.)
  return publishAndGetPermalink(igUserId, carouselId, accessToken);
}

// ---------------------------------------------------------------------------
// Per-post orchestration
// ---------------------------------------------------------------------------

async function processPost(env, post) {
  // Atomically claim the post. If another overlapping run already claimed it,
  // bail out immediately — do NOT publish (prevents double-posting to Instagram).
  const won = await claimPost(env, post.id);
  if (!won) return;

  // Look up the access token for this user.
  const tokenRow = await env.DB.prepare(
    `SELECT access_token FROM ig_tokens WHERE ig_user_id = ?`
  ).bind(post.ig_user_id).first();

  if (!tokenRow || !tokenRow.access_token) {
    // No token at all — permanent failure, nothing to retry against.
    await markFailed(env, post.id, 'No token for user');
    return;
  }

  // Decrypt the IG access token before presenting it to Meta.
  let accessToken;
  try {
    accessToken = await decryptToken(tokenRow.access_token, env);
  } catch (err) {
    console.error(`Token decrypt failed for post ${post.id}:`, { message: err?.message });
    await handleRetryableFailure(env, post, 'Token decrypt failed');
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

  try {
    let permalink;
    if (post.type === 'reel') {
      permalink = await postReel(post, assetKeys, accessToken);
    } else if (post.type === 'carousel') {
      permalink = await postCarousel(post, assetKeys, accessToken);
    } else {
      // Unknown type — not retryable.
      await markFailed(env, post.id, `Unknown post type: ${post.type}`);
      return;
    }

    await markPosted(env, post.id, permalink);
    console.log(`Post ${post.id} published: ${permalink}`);
  } catch (err) {
    // Token expired/invalid — fail permanently with the sentinel the desktop
    // app polls for, regardless of retry_count.
    if (err instanceof IgApiError && err.igCode === 190) {
      await markFailed(env, post.id, 'TOKEN_EXPIRED');
      console.error(`Post ${post.id} failed: token expired (code 190)`);
      return;
    }

    // Any other error is treated as transient -> retry up to the cap.
    const message = (err && err.message) ? err.message : String(err);
    await handleRetryableFailure(env, post, message.slice(0, 1000));
  }
}

// ---------------------------------------------------------------------------
// Token refresh (long-lived IG tokens must be refreshed before expiry)
// ---------------------------------------------------------------------------

async function refreshExpiringTokens(env) {
  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT ig_user_id, access_token FROM ig_tokens
       WHERE token_expiry <= datetime('now', '+7 days')`
    ).all();
    rows = result.results || [];
  } catch (err) {
    console.error('Token refresh: failed to query ig_tokens:', err);
    return;
  }

  for (const row of rows) {
    try {
      const currentToken = await decryptToken(row.access_token, env);

      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', currentToken);

      const res = await fetch(url.toString());
      const data = await res.json();

      if (!res.ok || !data.access_token) {
        // Scalar-only log — `data` is the refresh response and can carry a token.
        console.error(`Token refresh failed for ${row.ig_user_id}:`, { status: res.status, code: data?.error?.code });
        continue;
      }

      // expires_in is in seconds (typically ~60 days for IG long-lived tokens).
      const expiryIso = new Date(Date.now() + (data.expires_in || 0) * 1000).toISOString();
      const encrypted = await encryptToken(data.access_token, env);
      await env.DB.prepare(
        `UPDATE ig_tokens SET access_token = ?, token_expiry = ?, updated_at = ? WHERE ig_user_id = ?`
      ).bind(encrypted, expiryIso, nowIso(), row.ig_user_id).run();

      console.log(`Refreshed token for ${row.ig_user_id}, new expiry ${expiryIso}`);
    } catch (err) {
      // Never let one user's refresh failure abort the rest.
      console.error(`Token refresh error for ${row.ig_user_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron entrypoint
// ---------------------------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    // Step 1 — find up to 10 due, still-scheduled posts under the retry cap.
    let duePosts = [];
    try {
      const result = await env.DB.prepare(
        `SELECT * FROM scheduled_posts
         WHERE post_at <= datetime('now')
           AND status = 'scheduled'
           AND retry_count < 5
         LIMIT 10`
      ).all();
      duePosts = result.results || [];
    } catch (err) {
      console.error('Poster: failed to query due posts:', err);
      // Still attempt the token-refresh pass below even if the query failed.
    }

    // Step 2/3 — process each post in isolation; one failure must not abort the run.
    for (const post of duePosts) {
      try {
        await processPost(env, post);
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

    // Step 4 — refresh tokens nearing expiry. Runs every cron tick, wrapped so a
    // failure here never affects publishing above.
    try {
      await refreshExpiringTokens(env);
    } catch (err) {
      console.error('Poster: token refresh pass failed:', err);
    }
  },
};
