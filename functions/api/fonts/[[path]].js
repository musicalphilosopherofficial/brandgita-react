/**
 * GET /api/fonts/* — the authenticated read path for the `brandgita-fonts` R2 mirror.
 *
 * WHY THIS EXISTS (founder, 2026-09-25): the product has not launched, so there is no
 * existing public dependent to preserve — and no reason to accept the risk a public r2.dev
 * URL carries: anyone who reverse-engineers ("jailbreaks") the shipped app and recovers that
 * URL gets the whole mirror for free, forever, outside our control. A sibling branch
 * (feature/font-r2-mirror, `tools/fonts/README.md`) reasoned the opposite way — the catalogue
 * is OFL/Apache-redistributable and the keys carry no creator identity, so a public URL "leaks
 * nothing". That is true about CONFIDENTIALITY, but it is not the risk being closed here: the
 * founder's call is about who gets to keep paying users only, not about whether the bytes are
 * sensitive. `tools/fonts/enable_public_read.sh` must not run, and if it already ran against
 * production, the bucket's public dev-url needs disabling to match this route.
 *
 * AUTH reuses functions/api/kits.js's exact pattern (bearer() + checkWhopLicense()), not
 * requireUserAuth from _auth.js — fonts are needed at kit-build time, which can happen before
 * a creator has connected Instagram and been issued a desktop_token. The Whop licence is the
 * only credential guaranteed to exist that early.
 *
 * NO TENANCY CHECK, deliberately. Unlike functions/api/bugreport/media/[key].js (one creator's
 * own recordings), the font mirror is the SAME manifest and the SAME files for every creator —
 * there is nothing to scope per-membership. A valid licence is the whole gate.
 *
 * KEY SHAPE is fixed by the harvest job that populated the bucket (tools/fonts/README.md):
 * `manifest.json` at the bucket root, or `families/<Family-Slug>/<weight>.ttf` /
 * `families/<Family-Slug>/LICENSE.txt`. The regex below is the same shape every one of the 138
 * keys currently in tools/fonts/mirror_state.json matches — anything else 404s before R2 is
 * ever touched, which is what makes path traversal a non-issue: a `..` segment cannot survive
 * the slug character class, so there is no path to reject separately from "not a real key".
 *
 * NO CORS, matching bugreport/media/[key].js's stance and for the same reason: this is desktop
 * client traffic, never a browser fetch, so there is no cross-origin case to support and no
 * reason to hand a browser page a way to even attempt sending a bearer token here.
 */

import { checkWhopLicense } from '../_whop.js';
import { bearer } from '../kits.js';
import { requireRateLimit, clientKey } from '../_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const FONT_KEY_SHAPE = /^families\/[A-Za-z0-9-]+\/(LICENSE\.txt|[0-9]{3}i?\.ttf)$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function contentTypeFor(key) {
  if (key === 'manifest.json') return 'application/json';
  if (key.endsWith('LICENSE.txt')) return 'text/plain; charset=utf-8';
  return 'font/ttf';
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const limited = await requireRateLimit(env, 'FONTS_LIMITER', clientKey(request, 'fonts'), CORS);
  if (limited) return limited;

  const licenseKey = bearer(request);
  if (!licenseKey) return json({ ok: false, error: 'a licence key is required' }, 401);

  const licence = await checkWhopLicense(licenseKey, env);
  if (!licence.ok) return json({ ok: false, error: licence.error }, licence.status);

  // Pages' [[path]] catch-all hands back an array of already-split segments. Decoding each
  // one BEFORE joining (rather than decoding the joined string once) means a segment cannot
  // smuggle an encoded `/` past the split and rejoin itself into a different key.
  const segments = Array.isArray(params.path) ? params.path : [params.path];
  let key;
  try {
    key = segments.map((s) => decodeURIComponent(s)).join('/');
  } catch {
    return json({ ok: false, error: 'Malformed path' }, 400);
  }

  if (key !== 'manifest.json' && !FONT_KEY_SHAPE.test(key)) {
    // 404, not 400 — a shape mismatch and a genuinely-missing object must look identical to
    // the caller, so this endpoint is never usable to enumerate what the real key scheme is.
    return json({ ok: false, error: 'Not found' }, 404);
  }

  let obj;
  try {
    obj = await env.FONTS_BUCKET.get(key);
  } catch (err) {
    console.error('fonts GET: R2 read failed', { key, message: err?.message });
    return json({ ok: false, error: 'Storage read failed' }, 500);
  }
  if (!obj) return json({ ok: false, error: 'Not found' }, 404);

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(key),
      'X-Content-Type-Options': 'nosniff',
      // private, no-store: this response is only ever valid for the bearer that fetched it.
      // A shared cache serving it to the next request WITHOUT that header would be handing
      // out an authenticated read for free — the same reasoning as bugreport/media/[key].js.
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
      ...CORS,
    },
  });
}
