const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-secret',
};

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

  if (request.method !== 'DELETE') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  if (request.headers.get('x-api-secret') !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const id = params.id;

  if (!id) {
    return json({ ok: false, error: 'Missing post id' }, 400);
  }

  // Fetch the post first so we can guard status and gather R2 keys
  let post;
  try {
    const result = await env.DB.prepare(
      `SELECT id, status, asset_keys, cover_key FROM scheduled_posts WHERE id = ?`
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
