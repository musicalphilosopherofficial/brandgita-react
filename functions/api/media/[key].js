import { requireUserAuth } from '../_auth.js';

const CORS_WRITE = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_WRITE },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_WRITE });
  }

  // params.key arrives URL-encoded from the router — decode it so slashes survive.
  const key = decodeURIComponent(params.key);

  if (!key) {
    return json({ ok: false, error: 'Missing key' }, 400);
  }

  // ── PUT — upload file to R2 (per-user bearer auth + key scoping) ────────────
  if (request.method === 'PUT') {
    const auth = await requireUserAuth(request, env);
    if (auth.error) return auth.error;

    // Enforce key prefix — user can only write to their own {ig_user_id}/ prefix
    if (!key.startsWith(`${auth.ig_user_id}/`)) {
      return json({ ok: false, error: 'You can only upload to your own user prefix' }, 403);
    }

    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

    try {
      await env.SCHEDULE_BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
      });
    } catch (err) {
      console.error('R2 put error:', err);
      return json({ ok: false, error: 'Upload to storage failed' }, 500);
    }

    return json({ ok: true, key });
  }

  // ── GET — serve file from R2 (no auth — Meta fetches these URLs directly) ──
  if (request.method === 'GET') {
    let obj;
    try {
      obj = await env.SCHEDULE_BUCKET.get(key);
    } catch (err) {
      console.error('R2 get error:', err);
      return json({ ok: false, error: 'Storage read failed' }, 500);
    }

    if (obj === null) {
      return json({ ok: false, error: 'Not found' }, 404);
    }

    const contentType =
      obj.httpMetadata?.contentType || 'application/octet-stream';

    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // no-store: never cache user video at Cloudflare edges. Keeps the asset
        // resident only in the Oceania R2 bucket and makes the privacy policy's
        // "deleted immediately after publish" promise literally true (no stale
        // edge copy can outlive the R2 deletion). Meta fetches each asset once
        // at post time, so caching offers no benefit here.
        'Cache-Control': 'private, no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
