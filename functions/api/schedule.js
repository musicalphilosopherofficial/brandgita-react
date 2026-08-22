import { requireUserAuth } from './_auth.js';
import { DEFAULT_PLATFORM, contractFor } from '../../shared/platform-contracts.js';

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

    // platform is OPTIONAL and defaults to 'ig'. Every desktop client shipped to date
    // omits it and must keep behaving identically — this endpoint is live with a paying
    // customer, and the desktop ships on its own release cadence, so requiring a field
    // older builds cannot send would break them the moment this deploys.
    const platform = body.platform ?? DEFAULT_PLATFORM;

    // project_slug is OPTIONAL, for exactly the same reason platform is: every desktop
    // build shipped so far omits it, and this endpoint is live with a paying customer.
    // A missing slug means "not linked to a project", which is the truthful value both
    // for older clients and for a post made outside one.
    //
    // Bounded and type-checked but NOT validated against anything — projects live in
    // ~/.bg/processing on the creator's machine and the server has never seen them. The
    // cap is here so a malformed client cannot write an unbounded string into a column
    // the cron reads every 60 seconds.
    let project_slug = body.project_slug ?? null;
    if (project_slug !== null) {
      if (typeof project_slug !== 'string') {
        return json({ ok: false, error: 'project_slug must be a string' }, 400);
      }
      project_slug = project_slug.trim().slice(0, 200) || null;
    }
    let contract;
    try {
      contract = contractFor(platform);
    } catch (err) {
      // An unknown platform is a 400 naming what IS supported — never a 500, and never a
      // silent fallback to Instagram, which would publish to the wrong network entirely.
      return json({ ok: false, error: err.message }, 400);
    }

    if (!id || !type || !Array.isArray(asset_keys) || asset_keys.length === 0 || !caption || !post_at) {
      return json(
        { ok: false, error: 'id, type, asset_keys (non-empty), caption and post_at are required' },
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
    const problems = contract.validateCreate({ type, asset_keys, caption });
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

    // post_at must be a valid ISO date and within the scheduling window. The R2
    // lifecycle deletes each asset 75 days after UPLOAD, so the window (60 days)
    // must stay safely under that — otherwise a far-future post would lose its
    // media before firing. 60-day window + 15-day backstop margin.
    const postAtMs = Date.parse(post_at);
    if (isNaN(postAtMs)) {
      return json({ ok: false, error: 'post_at must be a valid ISO 8601 date string' }, 400);
    }
    const nowMs = Date.now();
    if (postAtMs > nowMs + 60 * 24 * 60 * 60 * 1000) {
      return json({ ok: false, error: 'post_at cannot be more than 60 days in the future' }, 400);
    }

    const now = new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO scheduled_posts
           (id, ig_user_id, platform, type, asset_keys, cover_key, caption, post_at, status, permalink, error, retry_count, created_at, project_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, 0, ?, ?)`
      )
        .bind(
          id,
          ig_user_id,
          platform,
          type,
          JSON.stringify(asset_keys),
          cover_key ?? null,
          caption,
          post_at,
          now,
          // Which local project this came from, so the desktop sidebar can file the post
          // under it (decisions/content-project-model.md). Optional and never validated:
          // projects live in ~/.bg/processing on the creator's machine and the server has
          // no way to check a slug against anything. NULL means "not linked", which is the
          // honest value for a post made outside a project.
          project_slug
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
        `SELECT id, platform, type, post_at, status, permalink, error, caption, project_slug
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
