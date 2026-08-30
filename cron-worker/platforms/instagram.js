// cron-worker/platforms/instagram.js
//
// Instagram Graph API adapter — Wave 3 of the platform-adapter refactor. Every
// function below used to live directly in cron-worker/poster.js; the LOGIC is
// unchanged (moved verbatim). Two things did change, both mechanical:
//
//   1. Location. This file, not poster.js.
//
//   2. Calling convention for postReel/postCarousel/waitForContainerReady:
//      they took separate positional params (mediaBase, sleepFn,
//      pollIntervalMs, pollMaxMs) before — and postCarousel only ever received
//      mediaBase, never the poll params, because it had no poll loop yet. That
//      asymmetry was a latent trap: the day someone added polling to
//      carousels, sleepFn would have silently defaulted to a real 10s sleep in
//      tests, because nobody would think to add a parameter that already
//      "worked". They now all take one `deps` object, so any new injectable
//      is available everywhere automatically instead of by remembering to
//      thread one more positional parameter through every call site.
//
// loadCredentials() also changed SHAPE, not behaviour: the token lookup +
// decrypt used to live inline in poster.js's processPost and write directly
// to D1 on failure (markFailed / handleRetryableFailure). It now returns a
// structured result — {ok:true, creds} | {ok:false, permanent, error} — and
// the DISPATCHER (processPost, still in poster.js) decides which D1 write to
// make, since an adapter has no business making that call for platforms it
// doesn't know about. The permanent/retryable split itself is UNCHANGED and
// pinned by cron-worker/poster.test.js: no token row at all is permanent
// (nothing to retry against), a decrypt failure is retryable (e.g. a bad
// TOKEN_ENC_KEY rollout is worth trying again next tick).
//
// mediaUrl/nowIso are imported from ../util.js, not ../poster.js. They were
// tried as poster.js exports first, which made this a circular import
// (poster.js -> platforms/index.js -> platforms/instagram.js -> poster.js).
// That resolves by luck of which module happens to be the entry point (works
// when poster.js loads first, as it always does today; throws "Cannot access
// 'instagram' before initialization" if this file is ever imported directly)
// — confirmed empirically, not assumed. See cron-worker/util.js's header.

import { encryptToken, decryptToken } from '../_crypto.js';
import { mediaUrl, nowIso } from '../util.js';

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

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

// Poll a media container until it reaches FINISHED, or throw on ERROR/timeout.
// igUserId is unused (kept for call-site symmetry with publishAndGetPermalink,
// same as before the move) — a pre-existing artifact, not something this move
// introduces or should silently "fix".
async function waitForContainerReady(igUserId, creationId, accessToken, deps) {
  const { sleepFn, pollIntervalMs, pollMaxMs } = deps;
  const deadline = Date.now() + pollMaxMs;

  while (Date.now() < deadline) {
    const statusData = await igGet(creationId, 'status_code', accessToken);
    const code = statusData.status_code;

    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new IgApiError(`Container ${creationId} processing returned status ${code}`);
    }
    // IN_PROGRESS / PUBLISHED-not-yet — keep polling.
    await sleepFn(pollIntervalMs);
  }

  throw new IgApiError(`Container ${creationId} did not finish within ${pollMaxMs / 1000}s`);
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
async function postReel(post, assetKeys, accessToken, deps) {
  const igUserId = post.ig_user_id;

  if (!assetKeys.length) {
    throw new IgApiError('Reel has no asset keys');
  }

  const params = {
    media_type: 'REELS',
    video_url: mediaUrl(assetKeys[0], deps.mediaBase),
    caption: post.caption || '',
  };
  // cover_url is optional — only include when a cover_key exists.
  if (post.cover_key) {
    params.cover_url = mediaUrl(post.cover_key, deps.mediaBase);
  }

  const createRes = await igPost(`${igUserId}/media`, params, accessToken);
  const creationId = createRes.id;
  if (!creationId) {
    throw new IgApiError('Reel container creation returned no id');
  }

  // Reels are transcoded asynchronously; wait for FINISHED before publishing.
  await waitForContainerReady(igUserId, creationId, accessToken, deps);

  return publishAndGetPermalink(igUserId, creationId, accessToken);
}

// CAROUSEL: create one child container per image -> create carousel container
// -> publish -> permalink.
async function postCarousel(post, assetKeys, accessToken, deps) {
  const igUserId = post.ig_user_id;

  if (assetKeys.length < 2) {
    throw new IgApiError('Carousel requires at least 2 items');
  }

  // 1. Create a child container for each image.
  const childIds = [];
  for (const key of assetKeys) {
    const childRes = await igPost(
      `${igUserId}/media`,
      { image_url: mediaUrl(key, deps.mediaBase), is_carousel_item: 'true' },
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
// The adapter object. cron-worker/poster.js's processPost dispatches to this
// via cron-worker/platforms/index.js — see that file for why the registry
// itself is a plain static table.
// ---------------------------------------------------------------------------
export const instagram = Object.freeze({
  id: 'ig',

  // {ok:true, creds:{accessToken}} | {ok:false, permanent, error}.
  async loadCredentials(env, post) {
    const tokenRow = await env.DB.prepare(
      `SELECT access_token FROM ig_tokens WHERE ig_user_id = ?`
    ).bind(post.ig_user_id).first();

    if (!tokenRow || !tokenRow.access_token) {
      // No token at all — permanent failure, nothing to retry against.
      return { ok: false, permanent: true, error: 'No token for user' };
    }

    try {
      const accessToken = await decryptToken(tokenRow.access_token, env);
      return { ok: true, creds: { accessToken } };
    } catch (err) {
      console.error(`Token decrypt failed for post ${post.id}:`, { message: err?.message });
      return { ok: false, permanent: false, error: 'Token decrypt failed' };
    }
  },

  // {post, assetKeys, creds, deps} -> {permalink}. Throws on any failure; the
  // dispatcher (poster.js) decides retry vs permanent via isAuthExpired below.
  async publish({ post, assetKeys, creds, deps }) {
    const { accessToken } = creds;
    let permalink;
    if (post.type === 'reel') {
      permalink = await postReel(post, assetKeys, accessToken, deps);
    } else if (post.type === 'carousel') {
      permalink = await postCarousel(post, assetKeys, accessToken, deps);
    } else {
      // Defensive only — the dispatcher already checks post.type against this
      // platform's contract (shared/platform-contracts.js) before ever
      // calling publish(), so this branch should be unreachable in production.
      throw new IgApiError(`Unknown post type: ${post.type}`);
    }
    return { permalink };
  },

  // Detects whether an error means "the access token is dead" — NOT the
  // literal 'TOKEN_EXPIRED' sentinel itself. That string is fixed by the
  // dispatcher (the desktop app polls for it verbatim); this only decides
  // which errors trigger it.
  isAuthExpired(err) {
    return err?.igCode === 190;
  },

  // Long-lived IG tokens must be refreshed before they expire — periodic sweep,
  // called from poster.js's scheduled() once per cron tick. Optional on the
  // adapter contract in general: a platform whose model is lazy
  // refresh-at-publish-time (no long-lived token to sweep ahead of time) would
  // simply not implement this method.
  async refreshExpiringTokens(env) {
    let rows;
    try {
      // CRITICAL FIX 2026-08-30: the SAME lexicographic-string bug as poster.js's due-post
      // query. token_expiry is stored via `new Date(...).toISOString()` (functions/api/
      // token.js, token/refresh.js) — "...T...Z" — while datetime('now', '+7 days')
      // returns SQLite's own "... ..." format. A bare `<=` string-compares them, and 'T'
      // (0x54) sorts after ' ' (0x20), so a real token_expiry NEVER compares as due for
      // refresh regardless of the actual date. This is almost certainly why real Instagram
      // tokens have been expiring instead of auto-refreshing — the sweep that was supposed
      // to catch them 7 days ahead of time could never have matched a single real row.
      const result = await env.DB.prepare(
        `SELECT ig_user_id, access_token FROM ig_tokens
         WHERE datetime(token_expiry) <= datetime('now', '+7 days')`
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
  },
});
