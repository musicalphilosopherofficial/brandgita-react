import { requireUserAuth } from '../_auth.js';

const CORS_WRITE = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Hard ceiling per uploaded object. IG reels cap well under this; the limit
// exists to stop a valid token from streaming terabytes into R2 (cost bomb).
const MAX_BYTES = 600 * 1024 * 1024; // 600 MB

// Only real media may be stored. Blocks turning the bucket — which is served
// from the apex domain via GET — into an arbitrary-content / HTML / JS host
// (stored-XSS on brandgita.com, malware distribution under the brand).
const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'image/jpeg',
  'image/png',
]);

// Keys must look like {ig_user_id}/{reel|cover|carousel}/{name}.{ext}.
// Enforced on both PUT and GET so the endpoint can't be used to probe arbitrary
// bucket contents, and so the only secrecy (the random suffix) is required.
const KEY_SHAPE = /^[0-9]+\/(reel|cover|carousel)\/[A-Za-z0-9._-]+\.(mp4|mov|jpg|jpeg|png)$/;

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
  // decodeURIComponent throws on malformed input (e.g. %ZZ) — guard it.
  let key;
  try {
    key = decodeURIComponent(params.key);
  } catch {
    return json({ ok: false, error: 'Malformed key' }, 400);
  }

  if (!key || !KEY_SHAPE.test(key)) {
    return json({ ok: false, error: 'Invalid key' }, 400);
  }

  // ── PUT — upload file to R2 (per-user bearer auth + key scoping) ────────────
  if (request.method === 'PUT') {
    const auth = await requireUserAuth(request, env);
    if (auth.error) return auth.error;

    // Enforce key prefix — user can only write to their own {ig_user_id}/ prefix
    if (!key.startsWith(`${auth.ig_user_id}/`)) {
      return json({ ok: false, error: 'You can only upload to your own user prefix' }, 403);
    }

    // Content-type allowlist
    const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return json({ ok: false, error: 'Unsupported media type' }, 415);
    }

    // Reject oversize up front when the client declares a length.
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared && declared > MAX_BYTES) {
      return json({ ok: false, error: 'File too large' }, 413);
    }

    // Meter the stream so the cap holds even when Content-Length is absent or lying.
    let total = 0;
    const metered = request.body.pipeThrough(
      new TransformStream({
        transform(chunk, ctrl) {
          total += chunk.byteLength;
          if (total > MAX_BYTES) {
            ctrl.error(new Error('File too large'));
            return;
          }
          ctrl.enqueue(chunk);
        },
      })
    );

    try {
      await env.SCHEDULE_BUCKET.put(key, metered, { httpMetadata: { contentType } });
    } catch (err) {
      console.error('R2 put error:', { message: err?.message });
      // A stream aborted by the size meter lands here too.
      if (String(err?.message).includes('too large')) {
        return json({ ok: false, error: 'File too large' }, 413);
      }
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
      console.error('R2 get error:', { message: err?.message });
      return json({ ok: false, error: 'Storage read failed' }, 500);
    }

    if (obj === null) {
      return json({ ok: false, error: 'Not found' }, 404);
    }

    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';

    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // nosniff + attachment-style disposition: even if a non-media object
        // somehow exists, the browser won't execute it as HTML/JS on our origin.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // no-store: never cache user video at Cloudflare edges. Keeps the asset
        // resident only in the Oceania R2 bucket and makes the privacy policy's
        // "deleted immediately after publish" promise literally true.
        'Cache-Control': 'private, no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
