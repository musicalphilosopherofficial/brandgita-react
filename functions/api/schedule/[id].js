import { requireUserAuth } from '../_auth.js';
import { contractFor } from '../../../shared/platform-contracts.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Server-side scheduling horizon. Mirrors the desktop TierPolicy.can_schedule()
// baseline (30 days) — the server enforces its own bound rather than trusting the
// client. Deliberately kept at the strict 30-day creator-facing number, NOT the
// create endpoint's 45-day cap (30 + a 15-day backstop margin): that backstop exists
// so freshly-uploaded media has margin against R2's 75-day lifecycle, which is a
// creation-time concern, not a reschedule one. Letting a reschedule push a post past
// 30 days would exceed the real, advertised policy with no lifecycle justification
// for the extra room.
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

// ── PATCH /api/schedule/{id} — change a scheduled post in place ──
// Every field a scheduled post can change without becoming a different post: post_at, caption, cover_key, asset_keys (same type,
// same platform). Founder 2026-10-02: "all things that can be updated via api must be added" — a new cover used to cost a full
// re-upload of the video (DELETE wipes R2, POST needs fresh assets). A swapped key passes the SAME checks a new post gets: the
// caller's account prefix, the platform contract, and the object already in R2. The replaced objects are deleted from R2 only
// AFTER the row update succeeds, so a failed update never strands a post without its media. id, type, platform and the owner
// stay fixed. See PATCH_SCHEDULE_SPEC.md.
const PATCHABLE = new Set(['post_at', 'caption', 'cover_key', 'asset_keys']);

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

  // Unknown or fixed keys are a 400, not a silent no-op, so a client-side typo surfaces instead of hiding.
  for (const key of Object.keys(body)) {
    if (!PATCHABLE.has(key)) {
      return json({ ok: false, error: `Unexpected field: ${key} (patchable: ${[...PATCHABLE].join(', ')})` }, 400);
    }
  }
  const fields = Object.keys(body);
  if (fields.length === 0) {
    return json({ ok: false, error: `nothing to update (patchable: ${[...PATCHABLE].join(', ')})` }, 400);
  }

  const { post_at, caption, cover_key, asset_keys } = body;

  if (post_at !== undefined) {
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
  }
  if (caption !== undefined && typeof caption !== 'string') {
    return json({ ok: false, error: 'caption must be a string' }, 400);
  }
  if (cover_key !== undefined && typeof cover_key !== 'string') {
    return json({ ok: false, error: 'cover_key must be a string' }, 400);
  }
  if (asset_keys !== undefined && (!Array.isArray(asset_keys) || asset_keys.length === 0)) {
    return json({ ok: false, error: 'asset_keys must be a non-empty array' }, 400);
  }

  let post;
  try {
    post = await env.DB.prepare(
      `SELECT id, ig_user_id, status, caption, post_at, platform, type, asset_keys, cover_key FROM scheduled_posts WHERE id = ?`
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
  // Only a still-scheduled post may change. A post mid-flight or done must not change under the cron worker.
  if (post.status !== 'scheduled') {
    return json({ ok: false, error: `Cannot change a post that is already ${post.status}` }, 409);
  }

  let oldAssets = [];
  try {
    oldAssets = JSON.parse(post.asset_keys || '[]');
  } catch {
    console.error(`Malformed asset_keys for post ${id}:`, post.asset_keys);
  }
  const effective = {
    caption: caption !== undefined ? caption : post.caption,
    asset_keys: asset_keys !== undefined ? asset_keys : oldAssets,
  };

  // The platform contract judges the post as it WILL be (type fixed; new assets, new caption), exactly as POST would.
  let contract;
  try {
    contract = contractFor(post.platform || 'ig');
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }
  if (caption !== undefined || asset_keys !== undefined) {
    const problems = contract.validateCreate({ type: post.type, asset_keys: effective.asset_keys, caption: effective.caption });
    if (problems.length) {
      return json({ ok: false, error: problems.join('; ') }, 400);
    }
  }

  // New keys: the caller's account only (the cron serves them as public URLs), and already uploaded.
  const newKeys = [...(asset_keys || []), ...(cover_key !== undefined ? [cover_key] : [])];
  const prefix = `${ig_user_id}/`;
  for (const k of newKeys) {
    if (typeof k !== 'string' || !k.startsWith(prefix)) {
      return json({ ok: false, error: 'all asset keys must belong to your account' }, 403);
    }
  }
  for (const k of newKeys) {
    let head = null;
    try {
      head = await env.SCHEDULE_BUCKET.head(k);
    } catch (err) {
      console.error(`R2 head error for key '${k}' (scheduled_posts PATCH):`, { message: err?.message });
      return json({ ok: false, error: 'Could not check the new media in storage' }, 500);
    }
    if (!head) {
      return json({ ok: false, error: `${k} is not uploaded yet: upload it first, then patch` }, 400);
    }
  }

  const sets = [];
  const binds = [];
  if (post_at !== undefined) { sets.push('post_at = ?'); binds.push(post_at); }
  if (caption !== undefined) { sets.push('caption = ?'); binds.push(caption); }
  if (cover_key !== undefined) { sets.push('cover_key = ?'); binds.push(cover_key); }
  if (asset_keys !== undefined) { sets.push('asset_keys = ?'); binds.push(JSON.stringify(asset_keys)); }

  try {
    await env.DB.prepare(`UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds, id)
      .run();
  } catch (err) {
    console.error('D1 update error (scheduled_posts PATCH):', { message: err?.message });
    return json({ ok: false, error: 'Could not update post' }, 500);
  }

  // Replaced media leaves R2 only now that the row points at its successor. Best effort: the row is already right.
  const keep = new Set([...effective.asset_keys, cover_key !== undefined ? cover_key : post.cover_key]);
  const replaced = [
    ...(asset_keys !== undefined ? oldAssets : []),
    ...(cover_key !== undefined && post.cover_key ? [post.cover_key] : []),
  ].filter((k) => !keep.has(k));
  const deleteErrors = [];
  for (const key of replaced) {
    try {
      await env.SCHEDULE_BUCKET.delete(key);
    } catch (err) {
      console.error(`R2 delete error for replaced key '${key}':`, { message: err?.message });
      deleteErrors.push(key);
    }
  }

  const out = {
    ok: true,
    id,
    post_at: post_at !== undefined ? post_at : post.post_at,
    caption: effective.caption,
    cover_key: cover_key !== undefined ? cover_key : post.cover_key,
    asset_keys: effective.asset_keys,
  };
  if (deleteErrors.length) out.warning = `Updated, but some replaced media could not be removed from storage: ${deleteErrors.join(', ')}`;
  return json(out);
}
