// cron-worker/platforms/tiktok.js
//
// TikTok Content Posting API adapter: publishes a scheduled video (FILE_UPLOAD, direct post).
//
// WHY IT LIVES HERE AND NOT IN functions/api/tiktok: the web routes post on the creator's click and let
// the browser push chunks. A scheduled post has no browser, so the worker streams the object out of R2
// itself, in chunks, and polls TikTok until it reports the post published.
//
// SAME CLIENT AS THE WEB ROUTES. The API calls come from functions/api/_tiktok.js (pure functions with an
// injectable fetch, no Pages-only dependency), so request shapes cannot drift between the two paths. Only
// token storage differs: the cron worker holds TOKEN_ENC_KEY and reads/refreshes tiktok_connections itself.
//
// CONSENT STAYS CURRENT. creator_info is queried again at publish time. If the privacy level the creator
// chose at scheduling time is no longer one the account offers, the post FAILS with a plain message rather
// than being published at some other visibility.
//
// IDEMPOTENT RETRIES. TikTok publishes on its own once the last chunk lands, so the publish_id is saved the
// moment the upload completes (tt_publish_id). A retry that finds it only polls status: it never uploads a
// second copy or creates a second post. Before that point nothing is public, so a full retry is safe.
//
// ERROR CLASSES. An Error with `permanent = true` is creator-actionable and will never succeed on retry
// (wrong privacy level, unaudited-client rule, TikTok rejecting the file): the poster fails the post at
// once. Everything else (rate limits, 5xx, a chunk refused, still processing at the deadline) is retried.

import { encryptToken, decryptToken } from '../_crypto.js';
import {
  refreshAccess, queryCreator, initVideoPost, fetchStatus, isAllowedUploadUrl,
} from '../../functions/api/_tiktok.js';

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB: inside TikTok's 5–64 MB rule, small enough for Worker memory.
const REFRESH_MARGIN_MS = 60 * 1000;

// TikTok codes that will not change on retry. Anything else is treated as transient.
const PERMANENT_CODES = new Set([
  'unaudited_client_can_only_post_to_private_accounts',
  'privacy_level_option_mismatch',
  'spam_risk_too_many_posts',
  'spam_risk_user_banned_from_posting',
  'reached_active_user_cap',
  'invalid_param',
  'invalid_file_upload',
  'url_ownership_unverified',
]);

function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

// Mark a TikTok API error permanent when its code says retrying cannot help.
function classify(err) {
  const code = /TikTok API error: ([a-z_]+)/.exec(err?.message || '')?.[1];
  if (code && PERMANENT_CODES.has(code)) err.permanent = true;
  return err;
}

async function tryTikTok(fn) {
  try { return await fn(); } catch (err) { throw classify(err); }
}

async function saveRefreshed(env, membershipId, fresh) {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tiktok_connections
        SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, refresh_expires_at = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE membership_id = ?`
  ).bind(
    await encryptToken(fresh.access_token, env),
    await encryptToken(fresh.refresh_token, env),
    new Date(now + (fresh.expires_in || 86400) * 1000).toISOString(),
    new Date(now + (fresh.refresh_expires_in || 31536000) * 1000).toISOString(),
    membershipId,
  ).run();
}

const AUTH_EXPIRED = /access_token_invalid|invalid_grant|scope_not_authorized|token_expired/;

export const tiktok = Object.freeze({
  id: 'tt',

  // Written once every chunk is uploaded; read by the stale-claim reaper and by publish() itself.
  publishedIdColumn: 'tt_publish_id',

  // {ok:true, creds:{accessToken, bucket}} | {ok:false, permanent, error}
  async loadCredentials(env, post) {
    // A scheduled row belongs to an IG account; the TikTok connection belongs to the same Whop membership.
    const link = await env.DB.prepare(
      `SELECT whop_membership_id FROM ig_tokens WHERE ig_user_id = ?`
    ).bind(post.ig_user_id).first();
    const row = link?.whop_membership_id
      ? await env.DB.prepare(`SELECT * FROM tiktok_connections WHERE membership_id = ?`).bind(link.whop_membership_id).first()
      : null;
    if (!row) {
      return { ok: false, permanent: true, error: 'TikTok is not connected: connect TikTok in Brand Gita, then schedule the post again' };
    }

    try {
      if (Date.parse(row.expires_at) - Date.now() > REFRESH_MARGIN_MS) {
        return { ok: true, creds: { accessToken: await decryptToken(row.access_token_enc, env), bucket: env.SCHEDULE_BUCKET } };
      }
      if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
        return { ok: false, permanent: true, error: 'TikTok is not configured on the cron worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET secrets are missing)' };
      }
      const fresh = await refreshAccess(await decryptToken(row.refresh_token_enc, env), env);
      await saveRefreshed(env, row.membership_id, fresh);
      return { ok: true, creds: { accessToken: fresh.access_token, bucket: env.SCHEDULE_BUCKET } };
    } catch (err) {
      console.error(`TikTok credentials for post ${post.id} failed:`, { message: err?.message });
      if (/invalid_grant|invalid_request|refresh_token/.test(err?.message || '')) {
        return { ok: false, permanent: true, error: 'TikTok connection expired: reconnect TikTok in Brand Gita, then schedule the post again' };
      }
      return { ok: false, permanent: false, error: `TikTok credentials: ${err?.message || err}` };
    }
  },

  isAuthExpired(err) {
    return AUTH_EXPIRED.test(err?.message || '');
  },

  // Returns { permalink }. Throws on failure; see ERROR CLASSES above.
  async publish({ post, assetKeys, creds, deps }) {
    const { accessToken, bucket } = creds;
    const { sleepFn, pollIntervalMs, pollMaxMs, onMediaPublished } = deps;

    let options = {};
    try { options = post.tiktok_options ? JSON.parse(post.tiktok_options) : {}; } catch { options = {}; }

    let publishId = post.tt_publish_id || null;

    if (!publishId) {
      const key = assetKeys[0];

      // Re-check what the account allows NOW (consent is not stale).
      const creator = await tryTikTok(() => queryCreator(accessToken));
      const allowed = creator.privacy_level_options;
      if (Array.isArray(allowed) && !allowed.includes(options.privacy_level)) {
        throw permanentError(
          `privacy_level ${options.privacy_level} is not available for this TikTok account now (available: ${allowed.join(', ')}). Change the post's privacy and schedule it again`
        );
      }

      const head = await bucket.head(key);
      if (!head) throw permanentError(`media not found in storage: ${key}`);
      const size = head.size;
      const contentType = head.httpMetadata?.contentType || 'video/mp4';

      // TikTok: chunks 5–64 MB, sequential; a video under 5 MB is one chunk; the final chunk absorbs the
      // remainder (up to 128 MB). total_chunk_count = floor(size / chunk_size).
      const chunkSize = Math.min(size, CHUNK_SIZE);
      const totalChunks = Math.floor(size / chunkSize);

      const init = await tryTikTok(() => initVideoPost(accessToken, {
        ...options,
        title: options.title ?? post.caption ?? '',
        video_size: size,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      }));
      if (!init.publish_id || !isAllowedUploadUrl(init.upload_url)) {
        throw new Error('TikTok did not return a usable upload URL');
      }

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const length = i === totalChunks - 1 ? size - start : chunkSize;
        const part = await bucket.get(key, { range: { offset: start, length } });
        if (!part) throw new Error(`could not read bytes ${start}-${start + length - 1} of ${key} from storage`);
        const res = await fetch(init.upload_url, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${start + length - 1}/${size}`,
          },
          body: await part.arrayBuffer(),
        });
        // 206 = chunk accepted, more expected; 201 = final chunk, TikTok has the whole file.
        if (res.status !== 201 && res.status !== 206) {
          throw new Error(`TikTok refused chunk ${i + 1} of ${totalChunks} (HTTP ${res.status})`);
        }
      }

      publishId = init.publish_id;
      // From here TikTok publishes on its own: remember it so a retry never uploads again.
      await onMediaPublished(publishId);
    }

    // Poll until TikTok says the post is out.
    const deadline = Date.now() + pollMaxMs;
    while (true) {
      const st = await tryTikTok(() => fetchStatus(accessToken, publishId));
      if (st.status === 'PUBLISH_COMPLETE') {
        // A public post exposes its id; a private one does not. No post URL is invented here.
        return { permalink: null };
      }
      if (st.status === 'FAILED') {
        throw permanentError(`TikTok could not publish this video: ${st.fail_reason || 'unknown reason'}`);
      }
      if (Date.now() >= deadline) break;
      await sleepFn(pollIntervalMs);
    }
    throw new Error(`TikTok is still processing publish ${publishId}; will check again`);
  },
});
