import { requireUserAuth } from '../_auth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Server-side scheduling horizon. Mirrors the desktop TierPolicy.can_schedule()
// baseline (30 days) — the server enforces its own bound rather than trusting the
// client. Kept independent of schedule.js's 60-day create window on purpose: create
// bounds against the R2 lifecycle; reschedule bounds against product policy.
const RESCHEDULE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method === 'PATCH') {
    return handlePatch(context);
  }

  if (request.method !== 'DELETE') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  const id = params.id;

  if (!id) {
    return json({ ok: false, error: 'Missing post id' }, 400);
  }

  // Fetch the post and verify it belongs to the authenticated user
  let post;
  try {
    const result = await env.DB.prepare(
      `SELECT id, ig_user_id, status, asset_keys, cover_key FROM scheduled_posts WHERE id = ?`
    )
      .bind(id)
      .first();
    post = result;
  } catch (err) {
    console.error('D1 select error (scheduled_posts DELETE):', err);
    return json({ ok: false, error: 'Could not look up post' }, 500);
  }

  if (!post) {
    return json({ ok: false, error: 'Post not found' }, 404);
  }

  // Ownership check — users can only delete their own posts
  if (post.ig_user_id !== ig_user_id) {
    return json({ ok: false, error: 'Post not found' }, 404); // 404 not 403 — don't leak existence
  }

  if (post.status !== 'scheduled') {
    return json(
      { ok: false, error: `Cannot delete a post that is already ${post.status}` },
      400
    );
  }

  // Delete the database row
  try {
    await env.DB.prepare(`DELETE FROM scheduled_posts WHERE id = ?`).bind(id).run();
  } catch (err) {
    console.error('D1 delete error (scheduled_posts):', err);
    return json({ ok: false, error: 'Could not delete post' }, 500);
  }

  // Delete R2 assets — parse asset_keys JSON, include cover_key if present
  let assetKeys = [];
  try {
    assetKeys = JSON.parse(post.asset_keys || '[]');
  } catch {
    // Malformed stored JSON — log and continue; row is already deleted
    console.error(`Malformed asset_keys for post ${id}:`, post.asset_keys);
  }

  if (post.cover_key) {
    assetKeys.push(post.cover_key);
  }

  // Best-effort R2 cleanup — don't fail the response if storage delete errors
  const deleteErrors = [];
  for (const key of assetKeys) {
    try {
      await env.SCHEDULE_BUCKET.delete(key);
    } catch (err) {
      console.error(`R2 delete error for key '${key}':`, err);
      deleteErrors.push(key);
    }
  }

  if (deleteErrors.length > 0) {
    // Row is gone; surface the storage issue as a warning, not a failure
    return json({
      ok: true,
      warning: `Post deleted but some assets could not be removed from storage: ${deleteErrors.join(', ')}`,
    });
  }

  return json({ ok: true });
}

// ── PATCH /api/schedule/{id} — reschedule (and optionally re-caption) in place ──
// A NARROW patch: move a post's post_at, without re-uploading its media. Touches
// D1 only — never R2. Swapping media is deliberately rejected (that's a different
// post the cron worker never validated). See PATCH_SCHEDULE_SPEC.md.
async function handlePatch(context) {
  const { request, env, params } = context;

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  const id = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'Body must be a JSON object' }, 400);
  }

  // Whitelist the keys we accept. Anything else — including the explicitly
  // forbidden asset_keys/type/cover_key/id/ig_user_id — is a 400, not a silent
  // no-op, so a client-side typo surfaces instead of hiding.
  const ALLOWED = new Set(['post_at', 'caption']);
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) {
      return json({ ok: false, error: `Unexpected field: ${key}` }, 400);
    }
  }

  const { post_at, caption } = body;

  if (post_at === undefined) {
    return json({ ok: false, error: 'post_at is required' }, 400);
  }

  const postAtMs = Date.parse(post_at);
  if (typeof post_at !== 'string' || isNaN(postAtMs)) {
    return json({ ok: false, error: 'post_at must be a valid ISO 8601 date string' }, 400);
  }

  const nowMs = Date.now();
  if (postAtMs <= nowMs) {
    return json({ ok: false, error: 'post_at must be in the future' }, 400);
  }
  if (postAtMs > nowMs + RESCHEDULE_HORIZON_MS) {
    return json({ ok: false, error: 'post_at cannot be more than 30 days in the future' }, 400);
  }

  // caption is optional; when present it obeys the same bound POST enforces.
  const patchCaption = caption !== undefined;
  if (patchCaption && (typeof caption !== 'string' || caption.length > 2200)) {
    return json({ ok: false, error: 'caption must be a string up to 2200 characters' }, 400);
  }

  // Fetch the post to check ownership + status. caption is selected so we can
  // echo the effective value back when the caller didn't change it.
  let post;
  try {
    post = await env.DB.prepare(
      `SELECT id, ig_user_id, status, caption FROM scheduled_posts WHERE id = ?`
    )
      .bind(id)
      .first();
  } catch (err) {
    console.error('D1 select error (scheduled_posts PATCH):', { message: err?.message });
    return json({ ok: false, error: 'Could not look up post' }, 500);
  }

  if (!post) {
    return json({ ok: false, error: 'Post not found' }, 404);
  }

  // Ownership — 404 not 403, so we never leak that another user's post exists.
  if (post.ig_user_id !== ig_user_id) {
    return json({ ok: false, error: 'Post not found' }, 404);
  }

  // Only a still-scheduled post may be moved. A post mid-flight or done must not
  // have its time changed under the cron worker.
  if (post.status !== 'scheduled') {
    return json(
      { ok: false, error: `Cannot reschedule a post that is already ${post.status}` },
      409
    );
  }

  const effectiveCaption = patchCaption ? caption : post.caption;

  try {
    if (patchCaption) {
      await env.DB.prepare(
        `UPDATE scheduled_posts SET post_at = ?, caption = ? WHERE id = ?`
      )
        .bind(post_at, caption, id)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE scheduled_posts SET post_at = ? WHERE id = ?`
      )
        .bind(post_at, id)
        .run();
    }
  } catch (err) {
    console.error('D1 update error (scheduled_posts PATCH):', { message: err?.message });
    return json({ ok: false, error: 'Could not reschedule post' }, 500);
  }

  return json({ ok: true, id, post_at, caption: effectiveCaption });
}
