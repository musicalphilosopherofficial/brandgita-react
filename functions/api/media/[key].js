import { mediaSlug, requireUserAuth } from '../_auth.js';

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

// Keys look like {prefix}/{reel|cover|carousel}/{name}.{ext}.
//
// The prefix is an opaque 20-hex media slug (see mediaSlug in ../_auth.js). It used to
// be the raw ig_user_id, which meant every PUBLIC media URL — and these are public by
// design, Instagram fetches them unauthenticated — published the creator's Instagram
// account ID, and any two URLs sharing a prefix proved they were the same person. The
// uuid protected the FILE; nothing protected the IDENTITY.
//
// The numeric form is still ACCEPTED so objects uploaded before the change keep
// serving — a scheduled post that stops fetching is a failed publish for a creator who
// did nothing wrong. New keys are always slugs.
// The readable form is `<song>-by-<artist>-<20 hex>`; the words are decoration and the
// 20 hex chars carry all 80 bits. `{1,60}` is bounded on purpose — an unbounded
// character class in front of a fixed-width group is a backtracking trap.
const KEY_SHAPE =
  /^([0-9]+|[a-z-]{1,60}-[0-9a-f]{20}|[0-9a-f]{20})\/(reel|cover|carousel)\/[A-Za-z0-9._-]+\.(mp4|mov|jpg|jpeg|png)$/;

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

  // Bug-report recordings share this bucket and must NEVER be reachable from here. GET
  // below has no auth by design (Instagram fetches scheduled reels unauthenticated), so
  // a recording served from this route would be readable by anyone holding the URL —
  // the exact regression decisions/in-app-bug-reporting.md refused, and the reason
  // /api/bugreport/media/{key} exists as a separate, licence-gated route.
  //
  // KEY_SHAPE already excludes those keys three times over (first segment, second
  // segment, extension), and functions/api/bugreport/_media.js pins that. This explicit
  // refusal is deliberately redundant: the shape check is a property of a regex someone
  // may one day widen, whereas this line states the rule in a form that has to be
  // deleted on purpose.
  if (key.startsWith('bugreport/')) {
    console.warn('media: refused a bug-report key on the unauthenticated route');
    return json({ ok: false, error: 'Invalid key' }, 400);
  }

  if (!key || !KEY_SHAPE.test(key)) {
    return json({ ok: false, error: 'Invalid key' }, 400);
  }

  // ── PUT — upload file to R2 (per-user bearer auth + key scoping) ────────────
  if (request.method === 'PUT') {
    const auth = await requireUserAuth(request, env);
    if (auth.error) return auth.error;

    // Enforce key prefix — a user may only write under their own prefix. The slug is
    // RE-DERIVED from the authenticated ig_user_id, never taken from the request, so it
    // remains a real tenancy check and not a value the client asserts about itself.
    const slug = await mediaSlug(env, auth.ig_user_id);
    if (!key.startsWith(`${slug}/`) && !key.startsWith(`${auth.ig_user_id}/`)) {
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

    // R2Bucket.put() REQUIRES a stream with a known length — it throws "the provided
    // readable stream must have a known length" for a plain ReadableStream. Piping the
    // request body through a bare `new TransformStream()` (the previous code) produces
    // exactly that: piping strips the length the runtime tracked on the original
    // request body, so every real upload landed in the catch block below as a generic
    // 500 ("Upload to storage failed"). This was the production upload bug — found
    // 2026-08-30 running the real desktop app against production; diagnosed and
    // unit-verified in isolation, not deploy-verified (no local workerd/R2 available).
    //
    // Fix: when a Content-Length was declared (true for every real client — the desktop
    // app's fetch sends a fixed-size Buffer, whose length undici/fetch sets
    // automatically), pass it back as `expectedLength` so the piped stream still reads
    // as fixed-length to the runtime and to R2.
    let uploadBody;

    if (declared > 0) {
      // Meter the stream so the cap holds even if a chunked body lies about total size
      // vs. the declared header — `expectedLength` only affects what R2 is told up
      // front; the ctrl.error() below still aborts an over-length upload mid-flight.
      let total = 0;
      uploadBody = request.body.pipeThrough(
        new TransformStream({
          expectedLength: declared,
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
    } else {
      // No Content-Length at all (a genuinely chunked client body). R2 still needs a
      // known length and there is nothing to declare up front, so buffer fully instead
      // of streaming blind — MAX_BYTES bounds the memory this can cost.
      let buf;
      try {
        buf = await request.arrayBuffer();
      } catch (err) {
        console.error('Request body read error:', { message: err?.message });
        return json({ ok: false, error: 'Upload to storage failed' }, 500);
      }
      if (buf.byteLength > MAX_BYTES) {
        return json({ ok: false, error: 'File too large' }, 413);
      }
      uploadBody = buf;
    }

    try {
      await env.SCHEDULE_BUCKET.put(key, uploadBody, { httpMetadata: { contentType } });
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
