import { requireUserAuth } from './_auth.js';
import { DEFAULT_PLATFORM, contractFor, resolveTrialStrategy, canonicalPlatform } from '../../shared/platform-contracts.js';
import { validateUserTags } from '../../shared/user-tags.js';
import { judgeFile } from '../../shared/media-specs.js';
import { assetKindOf, userTagTypes } from '../../shared/platform-contracts.js';
import { resolveTikTokOptions, flattenTikTok, TIKTOK_FIELDS } from '../../shared/tiktok-options.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Per-user bearer auth — ig_user_id is scoped to the token, not caller-supplied
  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  // ── POST — create a scheduled post ────────────────────────────────────────
  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400);
    }

    // ig_user_id comes from the bearer token — not from the body (never trust caller-supplied user id)
    const { id, asset_keys, cover_key, post_at } = body;

    // platform is OPTIONAL and defaults to 'ig'. Every desktop client shipped to date
    // omits it and must keep behaving identically — this endpoint is live with a paying
    // customer, and the desktop ships on its own release cadence, so requiring a field
    // older builds cannot send would break them the moment this deploys.
    // 'tiktok' and 'tt' (likewise 'instagram'/'ig') are the same platform: stored and returned as the canonical id.
    const platform = canonicalPlatform(body.platform ?? DEFAULT_PLATFORM);
    // A TikTok post is always one video, so `type` may be left out; its caption may be too (the title is used).
    const type = body.type ?? (platform === 'tt' ? 'reel' : undefined);
    let contract;
    try {
      contract = contractFor(platform);
    } catch (err) {
      // An unknown platform is a 400 naming what IS supported — never a 500, and never a
      // silent fallback to Instagram, which would publish to the wrong network entirely.
      return json({ ok: false, error: err.message }, 400);
    }
    // Whether a caption is mandatory is a fact about the platform's content type (a story has none, TikTok falls back to its title),
    // so it comes from the contract, not from a platform check here.
    const captionNeeded = contract.captionRequired(type);
    const caption = body.caption ?? (platform === 'tt' ? (typeof body.title === 'string' ? body.title : '') : (captionNeeded ? undefined : ''));

    if (!id || !type || !Array.isArray(asset_keys) || asset_keys.length === 0 || (!caption && captionNeeded) || !post_at) {
      return json(
        { ok: false, error: captionNeeded
          ? 'id, type, asset_keys (non-empty), caption and post_at are required'
          : 'id, type, asset_keys (non-empty) and post_at are required' },
        400
      );
    }
    if (typeof caption !== 'string') {
      return json({ ok: false, error: 'caption must be a string' }, 400);
    }

    // Content-shape rules live in the platform contract, not here: the valid types, the
    // asset counts, and the caption cap are all facts about Instagram specifically
    // (2200 chars is Meta's limit; YouTube's is 5000). Keeping them in this generic
    // handler is what would make it silently wrong for platform two.
    const problems = contract.validateCreate({ type, asset_keys, caption, cover_key });
    // Trial strategy: validated HERE, when the row is created. No client value means NOT a trial
    // (NULL); only an explicit, valid value makes the cron send trial_params.
    const trial = resolveTrialStrategy(contract, { type, requested: body.trial_strategy });
    problems.push(...trial.problems);
    // TikTok's per-post choices. Refused on other platforms rather than dropped: a creator who sent a
    // privacy_level must not believe it was applied to an Instagram post.
    const tikTokGiven = TIKTOK_FIELDS.filter((f) => body[f] !== undefined);
    const tikTok = platform === 'tt' ? resolveTikTokOptions(body) : null;
    if (tikTok) problems.push(...tikTok.problems);
    else if (tikTokGiven.length) problems.push(`${tikTokGiven.join(', ')} only apply to TikTok posts`);
    // user_tags: only for content types whose contract opts in (a story). Refused elsewhere rather than dropped.
    let userTags = null;
    if (body.user_tags !== undefined && body.user_tags !== null) {
      if (contract.shapes[type]?.userTags) {
        const ut = validateUserTags(body.user_tags);
        problems.push(...ut.problems);
        userTags = ut.tags;
      } else {
        const ok = userTagTypes(contract);
        problems.push(ok.length ? `user_tags only apply to: ${ok.join(', ')} (this post is a ${type})` : `${contract.label || contract.id} does not support user_tags`);
      }
    }

    // Media facts (width/height/duration/bytes) the client MAY send for content types that judge them (a story): hard limits are
    // problems, an advisory aspect is a warning returned beside the id. Without them, the aspect tagged on the asset at upload
    // time (assets.aspect) still yields the warning. Never blocks a create on a failed lookup.
    const warnings = [];
    const shape = contract.shapes[type];
    if (shape?.checkMedia && problems.length === 0) {
      const m = body.media && typeof body.media === 'object' && !Array.isArray(body.media) ? body.media : null;
      const kind = assetKindOf(asset_keys[0]);
      if (m) {
        const j = judgeFile(platform, type, { kind, width: m.width, height: m.height, durationSec: m.duration_sec, bytes: m.bytes });
        problems.push(...j.problems);
        warnings.push(...j.warnings);
      } else {
        try {
          const row = await env.DB.prepare(`SELECT aspect FROM assets WHERE key = ?`).bind(asset_keys[0]).first();
          const [w, h] = String(row?.aspect || '').split(':').map(Number);
          if (w > 0 && h > 0) warnings.push(...judgeFile(platform, type, { kind, width: w, height: h }).warnings);
        } catch (err) {
          console.error('D1 select error (assets aspect):', { message: err?.message });
        }
      }
    }
    if (problems.length) {
      // Every problem at once — a creator fixing one field per request is a worse
      // experience than being told all of it up front.
      return json({ ok: false, error: problems.join('; ') }, 400);
    }

    // Every asset_key (and cover_key) must live under THIS user's prefix — the cron
    // turns these into public media URLs, so a foreign key would expose/serve another
    // user's object. ig_user_id is token-derived, so this is a hard ownership check.
    const prefix = `${ig_user_id}/`;
    const allKeys = [...asset_keys, ...(cover_key ? [cover_key] : [])];
    for (const k of allKeys) {
      if (typeof k !== 'string' || !k.startsWith(prefix)) {
        return json({ ok: false, error: 'all asset keys must belong to your account' }, 403);
      }
    }

    // post_at must be a valid ISO date and within the scheduling window. 45 days = the
    // 30-day creator-facing scheduling policy + a 15-day server-side backstop margin (never
    // shown to the creator — the real promise is 30). The R2 lifecycle deletes each asset 75
    // days after upload, so this 45-day cap is what keeps that backstop safe: even at the
    // ceiling, a post still has 30 days of margin before its media would be cleaned up.
    const postAtMs = Date.parse(post_at);
    if (isNaN(postAtMs)) {
      return json({ ok: false, error: 'post_at must be a valid ISO 8601 date string' }, 400);
    }
    const nowMs = Date.now();
    if (postAtMs > nowMs + 45 * 24 * 60 * 60 * 1000) {
      return json({ ok: false, error: 'post_at cannot be more than 45 days in the future' }, 400);
    }

    // Idempotency: the same account, platform, asset(s) and post_at is the same post. A client that retries
    // (or re-sends with a fresh id) gets the existing post back, never a second row that would publish twice.
    // A FAILED post does not count — re-scheduling after a failure is legitimate.
    const assetKeysJson = JSON.stringify(asset_keys);
    try {
      const dupe = await env.DB.prepare(
        `SELECT id, post_at FROM scheduled_posts
          WHERE ig_user_id = ? AND platform = ? AND asset_keys = ? AND post_at = ? AND status != 'failed'
          LIMIT 1`
      ).bind(ig_user_id, platform, assetKeysJson, post_at).first();
      if (dupe?.id) return json({ ok: true, id: dupe.id, post_at: dupe.post_at, duplicate: true });
    } catch (err) {
      console.error('D1 select error (scheduled_posts duplicate check):', { message: err?.message });
      return json({ ok: false, error: 'Could not check for an existing post' }, 500);
    }

    const now = new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO scheduled_posts
           (id, ig_user_id, platform, type, asset_keys, cover_key, caption, post_at, status, permalink, error, retry_count, created_at, trial_strategy, tiktok_options, user_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, 0, ?, ?, ?, ?)`
      )
        .bind(
          id,
          ig_user_id,
          platform,
          type,
          assetKeysJson,
          cover_key ?? null,
          caption,
          post_at,
          now,
          trial.strategy,
          tikTok ? JSON.stringify(tikTok.options) : null,
          userTags ? JSON.stringify(userTags) : null
        )
        .run();
    } catch (err) {
      console.error('D1 insert error (scheduled_posts):', { message: err?.message });
      // Generic conflict — don't echo the caller-supplied id (cross-tenant existence oracle).
      if (err.message?.includes('UNIQUE') || err.message?.includes('unique')) {
        return json({ ok: false, error: 'A post with this id already exists' }, 409);
      }
      return json({ ok: false, error: 'Could not save scheduled post' }, 500);
    }

    return json({ ok: true, id, post_at, ...(warnings.length ? { warnings } : {}) });
  }

  // ── GET — list scheduled posts for the authenticated user ────────────────
  if (request.method === 'GET') {
    // ig_user_id is scoped from the bearer token — no query param needed/accepted

    // Optional filters: ?platform=tiktok (any alias) and ?status=scheduled. No filter = every post, as before.
    const q = request.url ? new URL(request.url).searchParams : new URLSearchParams();
    const where = ['ig_user_id = ?'];
    const binds = [ig_user_id];
    if (q.get('platform')) { where.push('platform = ?'); binds.push(canonicalPlatform(q.get('platform'))); }
    if (q.get('status')) { where.push('status = ?'); binds.push(q.get('status')); }

    let rows;
    try {
      const result = await env.DB.prepare(
        `SELECT id, platform, type, post_at, status, permalink, error, retry_count, caption, trial_strategy, tiktok_options, user_tags
         FROM scheduled_posts
         WHERE ${where.join(' AND ')}
         ORDER BY post_at ASC`
      )
        .bind(...binds)
        .all();
      rows = result.results.map(flattenTikTok).map((r) => { if (!r.user_tags) return r; try { return { ...r, user_tags: JSON.parse(r.user_tags) }; } catch { return { ...r, user_tags: null }; } });
    } catch (err) {
      console.error('D1 select error (scheduled_posts):', err);
      return json({ ok: false, error: 'Could not fetch scheduled posts' }, 500);
    }

    return json({ ok: true, posts: rows });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
