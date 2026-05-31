import { requireUserAuth } from './_auth.js';

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
    const { id, type, asset_keys, cover_key, caption, post_at } = body;

    if (!id || !type || !Array.isArray(asset_keys) || asset_keys.length === 0 || !caption || !post_at) {
      return json(
        { ok: false, error: 'id, type, asset_keys (non-empty), caption and post_at are required' },
        400
      );
    }

    if (!['reel', 'carousel'].includes(type)) {
      return json({ ok: false, error: "type must be 'reel' or 'carousel'" }, 400);
    }

    // Caption length — Instagram's own cap is 2200 chars. Bounds the DB write and
    // the cron's API call.
    if (typeof caption !== 'string' || caption.length > 2200) {
      return json({ ok: false, error: 'caption must be a string up to 2200 characters' }, 400);
    }

    // Asset count — reel is exactly 1 video; carousel is 2–10 items. Without a cap,
    // one post could spawn hundreds of IG container calls and starve the cron.
    if (type === 'reel' && asset_keys.length !== 1) {
      return json({ ok: false, error: 'a reel must have exactly 1 asset' }, 400);
    }
    if (type === 'carousel' && (asset_keys.length < 2 || asset_keys.length > 10)) {
      return json({ ok: false, error: 'a carousel must have 2–10 assets' }, 400);
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

    // post_at must be a valid ISO date, not in the past, and within the scheduling
    // window. The R2 lifecycle deletes assets after 45 days, so a post scheduled
    // beyond that would lose its media before firing — cap at 30 days.
    const postAtMs = Date.parse(post_at);
    if (isNaN(postAtMs)) {
      return json({ ok: false, error: 'post_at must be a valid ISO 8601 date string' }, 400);
    }
    const nowMs = Date.now();
    if (postAtMs > nowMs + 30 * 24 * 60 * 60 * 1000) {
      return json({ ok: false, error: 'post_at cannot be more than 30 days in the future' }, 400);
    }

    const now = new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO scheduled_posts
           (id, ig_user_id, type, asset_keys, cover_key, caption, post_at, status, permalink, error, retry_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, 0, ?)`
      )
        .bind(
          id,
          ig_user_id,
          type,
          JSON.stringify(asset_keys),
          cover_key ?? null,
          caption,
          post_at,
          now
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

    return json({ ok: true, id });
  }

  // ── GET — list scheduled posts for the authenticated user ────────────────
  if (request.method === 'GET') {
    // ig_user_id is scoped from the bearer token — no query param needed/accepted

    let rows;
    try {
      const result = await env.DB.prepare(
        `SELECT id, type, post_at, status, permalink, error, caption
         FROM scheduled_posts
         WHERE ig_user_id = ?
         ORDER BY post_at ASC`
      )
        .bind(ig_user_id)
        .all();
      rows = result.results;
    } catch (err) {
      console.error('D1 select error (scheduled_posts):', err);
      return json({ ok: false, error: 'Could not fetch scheduled posts' }, 500);
    }

    return json({ ok: true, posts: rows });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
