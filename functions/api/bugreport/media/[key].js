/**
 * GET /api/bugreport/media/{key} — serve one bug-report recording, authenticated.
 *
 * THIS IS THE WHOLE REASON THE FEATURE COULD NOT SHIP EARLIER.
 *
 * `functions/api/media/[key].js` serves GET with no auth check whatsoever, deliberately:
 * Instagram fetches scheduled reels from those URLs without credentials, so gating them
 * would break publishing. `electron-shell/bugreport.js` names the consequence exactly —
 * a URL on that route "is not a reference to a credential — it IS one" — and rejected
 * attaching any media URL to a bug report on those grounds.
 *
 * Putting a creator's screen recording behind that route would have been the security
 * regression the earlier design refused. This route is the alternative it asked for.
 *
 * TWO CHECKS, NOT ONE
 * -------------------
 *   AUTHENTICATION  a valid Whop licence, in X-License-Key. No licence, no bytes.
 *   TENANCY         the key must sit under the slug derived from THAT licence.
 *
 * The second is the one that is easy to leave out and easy to regret. Without it, every
 * licence holder could read every other creator's recordings — "authenticated" would be
 * true and the endpoint would still be broken. The slug is re-derived server-side from
 * the authenticated membership and compared against the key; it is never taken from the
 * request, so it stays a real check rather than a claim the client makes about itself.
 *
 * Support reads these through the same door. There is no bypass header and no ops-only
 * escape hatch, because a bypass is a credential that would then need its own story
 * about where it lives and who holds it.
 */

import { checkWhopLicense } from '../../_whop.js';
import { bugMediaSlug, isBugMediaKey, MEDIA_PREFIX } from '../_media.js';

// NO Access-Control-Allow-Origin, and no allowed-headers list, on ANY response from this
// route — success or error. The sibling public route sets `*` because Instagram and
// browsers fetch it cross-origin by design; here that would invite a page on any origin
// to read an authenticated response.
//
// Dropping the preflight headers is the point rather than an oversight: without them a
// browser cannot send X-License-Key cross-origin at all, so there is no cross-origin way
// to reach this route. The desktop client is not a browser context and never needed CORS.
//
// An earlier version set `*` on the error responses while omitting it from the 200 — the
// inconsistency was the bug (CodeRabbit, this PR): error bodies distinguish "wrong
// licence" from "not found", which is exactly the probing signal not to hand out.
const CORS = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const licenseKey = request.headers.get('X-License-Key');
  if (!licenseKey) {
    return json({ ok: false, error: 'X-License-Key is required' }, 401);
  }

  // params.key arrives URL-encoded from the router. decodeURIComponent throws on
  // malformed input (%ZZ) — guard it, same as the public route.
  let key;
  try {
    key = decodeURIComponent(params.key);
  } catch {
    return json({ ok: false, error: 'Malformed key' }, 400);
  }
  // Shape first, and shape includes the `bugreport/` prefix — so a traversal or a
  // hand-written key aimed at somebody's scheduled reel in the same bucket cannot be
  // laundered through this route either. The two routes are mutually exclusive by shape
  // in BOTH directions, not just one.
  if (!isBugMediaKey(key)) {
    return json({ ok: false, error: 'Invalid key' }, 400);
  }

  const licence = await (env.__checkWhopLicense || checkWhopLicense)(licenseKey, env);
  if (!licence.ok) {
    return json({ ok: false, error: licence.error || 'Licence check failed' }, licence.status || 403);
  }

  let slug;
  try {
    slug = await bugMediaSlug(env, licence.membershipId || 'unknown');
  } catch (err) {
    console.error('bugreport/media GET: slug derivation failed', { message: err?.message });
    return json({ ok: false, error: 'Media storage is not configured' }, 503);
  }

  if (!key.startsWith(`${MEDIA_PREFIX}${slug}/`)) {
    // A valid licence for the WRONG recording. 403 and not 404: the caller proved who
    // they are, so telling them this is not theirs leaks nothing they could not already
    // infer, and a 404 here would send support chasing a "missing" object that exists.
    return json({ ok: false, error: 'That recording belongs to a different licence' }, 403);
  }

  let obj;
  try {
    obj = await env.SCHEDULE_BUCKET.get(key);
  } catch (err) {
    console.error('bugreport/media GET: R2 read failed', { message: err?.message });
    return json({ ok: false, error: 'Storage read failed' }, 500);
  }
  if (obj === null || obj === undefined) {
    return json({ ok: false, error: 'Not found' }, 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // private, no-store: an authenticated response must never sit in a shared cache
      // where the next request could be served it WITHOUT the licence header. This is
      // load-bearing here in a way it is not on the public route, where the same header
      // is about data residency rather than about auth.
      'Cache-Control': 'private, no-store',
      // No Access-Control-Allow-Origin — see the CORS note at the top of this file.
      Vary: 'X-License-Key',
    },
  });
}
