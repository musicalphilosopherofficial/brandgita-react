/**
 * /api/google/token — the Google OAuth token exchange, done server-side.
 *
 * WHY THIS EXISTS (2026-08-29). The desktop app exchanged Google auth codes itself, reading
 * GOOGLE_CLIENT_SECRET from `electron-shell/.env` with `|| ''` as the fallback. That file is
 * deliberately NOT packaged (it also holds a licence-bypass flag), so in a shipped build the
 * fallback was always taken and the secret was always empty.
 *
 * The comment on that line claimed "PKCE carries the packaged flow". Measured against Google's
 * live endpoint with a deliberately bogus code, which separates a client failure from a code
 * failure:
 *
 *   empty client_secret  → invalid_request  "client_secret is missing."
 *   real  client_secret  → invalid_grant    "Malformed auth code."
 *
 * The second is the client authenticating fine and only the code being wrong. So Google
 * requires the secret for a Desktop client even WITH PKCE, and the comment was wrong. The
 * packaged failure was also the worst possible shape: consent screen, account picker, "allow"
 * — and only then a failure, after the creator had done everything right.
 *
 * WHY NOT JUST SHIP THE SECRET. Google documents desktop client secrets as not confidential,
 * so it would work. But it is still a credential in a bundle anyone can `asar extract`, one
 * that cannot be rotated without shipping a new build, and it would be the first exception to
 * a rule (build-config.js FORBIDDEN_KEYS) that is only useful while it has none. Instagram's
 * exchange already happens up here for exactly these reasons; this makes Google consistent
 * rather than special.
 *
 * WHAT THIS IS NOT. It does not store tokens, look at them, or log them — Google's response is
 * returned to the desktop app verbatim and the tokens live only on the creator's machine, the
 * same as before. The only thing added on this side is the client credential.
 *
 * ONE CREDENTIAL FOR THE WHOLE PRODUCT, not one per creator. GOOGLE_CLIENT_ID/SECRET identify
 * Brand Gita as an application to Google, exactly as IG_CLIENT_ID/SECRET already do for Meta.
 * Every creator's consent screen uses the same pair. What is per-creator is the access and
 * refresh token that comes back afterwards — and that never touches this endpoint's storage,
 * because this endpoint has none.
 *
 * ENVIRONMENT: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required. GOOGLE_REDIRECT_URI is
 * NOT — the desktop app always sends its own loopback (http://127.0.0.1:9877/callback), which
 * Google matches against the registered URI, so the value here is an unused fallback kept only
 * so a caller that omits it fails with a named error rather than Google's.
 */

import { requireRateLimit, clientKey } from '../_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The only two grants this proxy performs. Anything else is refused rather than forwarded. */
const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * Build the form body Google expects, or return a reason it cannot be built.
 *
 * Split out from the handler so the shape is testable without a network: every rejection
 * below is a case that used to surface as an opaque Google error inside the desktop app.
 */
export function buildTokenForm(body, { clientId, clientSecret, redirectUri }) {
  const grant = body && body.grant_type;
  if (!ALLOWED_GRANTS.has(grant)) {
    return { error: 'grant_type must be authorization_code or refresh_token' };
  }
  if (!clientId || !clientSecret) {
    // The deploy is misconfigured, not the caller's request. Saying so plainly is the whole
    // point — the bug this file exists for spent hours looking like a creator-side problem.
    return { error: 'server is missing Google credentials', status: 503 };
  }

  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: grant });

  if (grant === 'authorization_code') {
    if (!body.code) return { error: 'code is required' };
    if (!body.code_verifier) {
      // PKCE is not optional here. Without it the proxy would be an oracle that turns any
      // stolen auth code into tokens; with it, only the client that began the flow can finish.
      return { error: 'code_verifier is required' };
    }
    const redirect = body.redirect_uri || redirectUri;
    if (!redirect) return { error: 'redirect_uri is required' };
    form.set('code', body.code);
    form.set('code_verifier', body.code_verifier);
    form.set('redirect_uri', redirect);
  } else {
    if (!body.refresh_token) return { error: 'refresh_token is required' };
    form.set('refresh_token', body.refresh_token);
  }

  return { form };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const limited = await requireRateLimit(env, 'GOOGLE_TOKEN_LIMITER', clientKey(request, 'gtoken'), CORS);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const built = buildTokenForm(body, {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });
  if (built.error) return json({ ok: false, error: built.error }, built.status || 400);

  let res;
  let payload;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: built.form.toString(),
    });
    payload = await res.json();
  } catch (err) {
    // External I/O failure path — logged, because a silent one here reads to the creator as
    // "YouTube is broken" with nothing on either side to say why.
    console.error('Google token exchange failed:', { message: err?.message });
    return json({ ok: false, error: 'Could not reach Google' }, 502);
  }

  if (!res.ok) {
    // Google's own error is passed through: `invalid_grant` on an expired code needs a
    // different answer from the creator than `invalid_client` does, and flattening both into
    // "couldn't connect" is what made the original bug take hours to name.
    console.error('Google token exchange rejected:', { status: res.status, error: payload?.error });
    return json({ ok: false, error: payload?.error || 'token exchange failed', detail: payload?.error_description }, res.status);
  }

  return json({ ok: true, ...payload });
}
