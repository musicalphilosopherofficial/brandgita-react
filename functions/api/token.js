import { mediaSlug, requireUserAuth, sha256Hex } from './_auth.js';
import { checkWhopLicense, validateDevice } from './_whop.js';
import { encryptToken } from './_crypto.js';
import { requireRateLimit, clientKey } from './_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-secret, Authorization',
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

  // ── DELETE — revoke the caller's desktop token (logout / disconnect) ────────
  // Authenticated by the bearer token itself; nulls it so it can never be reused.
  if (request.method === 'DELETE') {
    const auth = await requireUserAuth(request, env);
    if (auth.error) return auth.error;
    try {
      await env.DB.prepare(
        `UPDATE ig_tokens SET desktop_token = NULL, desktop_token_created_at = NULL WHERE ig_user_id = ?`
      ).bind(auth.ig_user_id).run();
    } catch (err) {
      console.error('D1 revoke error (ig_tokens):', { message: err?.message });
      return json({ ok: false, error: 'Could not revoke token' }, 500);
    }
    return json({ ok: true, revoked: true });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  // Rate limit BEFORE the secret check, on purpose: the point is to slow down guessing
  // the secret, so a wrong guess must cost the attacker a token from their bucket. Doing
  // it after the check would only limit callers who already hold the secret — useless.
  //
  // Fails OPEN if the binding is absent (Pages support is undocumented). Verify with
  // rateLimitStatus rather than assuming it is live.
  const limited = await requireRateLimit(env, 'TOKEN_LIMITER', clientKey(request, 'token'), CORS);
  if (limited) return limited;

  // Shared-secret auth — OPTIONAL since 2026-08-29 (approach B).
  //
  // x-api-secret authenticates THE APP (any copy of our binary), never the customer — the
  // licence key below is the per-customer gate and always was. The secret lived in
  // electron-shell/.env, which was excluded from the desktop package after it was found
  // shipping inside app.asar next to a licence-bypass flag. Re-shipping it was not an option
  // (anyone owning the bundle extracts it), so a packaged app now sends no secret at all.
  //
  // WRONG is still rejected — only ABSENT is tolerated, and only when rate limiting is live.
  // requireRateLimit fails OPEN by design, so without this check an unbound limiter would
  // leave this endpoint completely unprotected, and every call spends Whop quota from a
  // 600/min bucket shared across all our operations (confirmed with Whop, 2026-08-29).
  const sentSecret = request.headers.get('x-api-secret');
  if (sentSecret !== null && sentSecret !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  // An ABSENT secret is only safe once this endpoint is rate-limited by something. On Pages
  // that cannot be code: wrangler rejects [[ratelimits]] for a Pages project outright, so
  // TOKEN_LIMITER can NEVER bind here and rateLimitIsLive() would be false forever — gating on
  // it would 503 every packaged app. The real protection is a WAF Rate Limiting Rule in the
  // Cloudflare dashboard, which is invisible to this code.
  //
  // So the operator asserts it explicitly. TOKEN_PUBLIC_OK is set ONLY after that WAF rule is
  // configured (decisions/public-endpoint-hardening.md). LIVE in production as of 2026-08-29 —
  // verified by posting a deliberately invalid licence key with NO x-api-secret header, which
  // returned 402 "License key not found" rather than 401: the request reached the Whop check,
  // so the absent secret was tolerated. Verify it that way rather than assuming, since nothing
  // in this file can observe the WAF rule that makes it safe.
  //
  // Fail closed regardless: an unset var means secret-required, the behaviour that has always
  // shipped, so a fresh environment is never accidentally open.
  if (sentSecret === null && env.TOKEN_PUBLIC_OK !== '1') {
    return json(
      { ok: false, error: 'Unauthorized' },
      401,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  // Whop entitlement check — the actual per-CUSTOMER gate. API_SECRET is shared across
  // every installed copy of the app; a licence key is not. Checked BEFORE touching the
  // OAuth `code`, which is single-use — validating license AFTER an OAuth exchange would
  // burn the creator's one-time code for nothing if their membership turns out lapsed,
  // forcing them to redo the entire Instagram permission grant just to be told no.
  //
  // Deliberately NOT device-locked (Whop's validate_license endpoint would do that) —
  // founder's call 2026-08-22: handle key-sharing via ToS + manual disable/refund until
  // it's an observed problem, not a technical lock from day one with no paying customers.
  const { license_key, device_hash } = body;
  const licenseCheck = await checkWhopLicense(license_key, env);
  if (!licenseCheck.ok) {
    return json({ ok: false, error: licenseCheck.error }, licenseCheck.status);
  }

  // Device lock — one active machine per licence. `device_hash` is computed and hashed
  // ON THE DESKTOP from a stable local machine identifier; this endpoint never sees or
  // stores the raw hardware value, only the hash Whop compares for equality.
  //
  // Required, not optional: an app build old enough to omit device_hash would otherwise
  // silently skip the lock entirely, and "some installs are locked, some aren't" is a
  // worse state than "everyone must upgrade to connect."
  if (!device_hash || typeof device_hash !== 'string') {
    return json({ ok: false, error: 'device_hash is required' }, 400);
  }
  const deviceCheck = await validateDevice(licenseCheck.membershipId, device_hash, env);
  if (!deviceCheck.ok) {
    return json({ ok: false, error: deviceCheck.error }, deviceCheck.status);
  }

  // Two accepted shapes:
  //   { code }                            — full OAuth exchange (desktop sends this)
  //   { ig_user_id, short_lived_token }   — legacy: caller already holds a short-lived token
  const { code } = body;
  let { ig_user_id, short_lived_token } = body;

  // Step 0 (code path only): trade the one-time OAuth code for a short-lived token.
  // This needs IG_CLIENT_SECRET, which is why it MUST happen server-side and never
  // in the distributed desktop app. The code-exchange response also tells us who
  // logged in (user_id), so the desktop doesn't need to know ig_user_id up front.
  if (code) {
    try {
      const form = new URLSearchParams();
      form.set('client_id', env.IG_CLIENT_ID);
      form.set('client_secret', env.IG_CLIENT_SECRET);
      form.set('grant_type', 'authorization_code');
      form.set('redirect_uri', env.IG_REDIRECT_URI);
      form.set('code', code);

      const codeRes = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const codeData = await codeRes.json();

      if (!codeRes.ok || !codeData.access_token || !codeData.user_id) {
        // Scalar-only log — the raw response can carry a token; never serialize it.
        console.error('IG code exchange error:', { status: codeRes.status, code: codeData?.error?.code });
        return json({ ok: false, error: 'OAuth code exchange failed' }, 502);
      }

      short_lived_token = codeData.access_token;
      ig_user_id = String(codeData.user_id);
    } catch (err) {
      console.error('Fetch error during IG code exchange:', err);
      return json({ ok: false, error: 'Failed to reach Instagram during code exchange' }, 502);
    }
  }

  if (!ig_user_id || !short_lived_token) {
    return json({ ok: false, error: 'Provide either {code} or {ig_user_id, short_lived_token}' }, 400);
  }

  // Exchange short-lived token for a long-lived (60-day) token via Instagram Graph API
  let igData;
  try {
    const exchangeUrl = new URL('https://graph.instagram.com/access_token');
    exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
    exchangeUrl.searchParams.set('client_secret', env.IG_CLIENT_SECRET);
    exchangeUrl.searchParams.set('access_token', short_lived_token);

    const igRes = await fetch(exchangeUrl.toString());
    igData = await igRes.json();

    if (!igRes.ok || !igData.access_token) {
      // Scalar-only log — never serialize igData (carries access_token).
      console.error('IG token exchange error:', { status: igRes.status, code: igData?.error?.code });
      return json({ ok: false, error: 'Token exchange failed' }, 502);
    }
  } catch (err) {
    console.error('Fetch error during IG token exchange:', err);
    return json({ ok: false, error: 'Failed to reach Instagram API' }, 502);
  }

  const { access_token, expires_in } = igData;
  const expiryDate = new Date(Date.now() + expires_in * 1000);
  const token_expiry = expiryDate.toISOString();
  const updated_at = new Date().toISOString();

  // Mint a per-user desktop bearer token. This replaces the shared API_SECRET for
  // all subsequent user-scoped API calls. We return the plaintext to the desktop
  // exactly once and store ONLY its SHA-256 hash — a D1 read can never yield a
  // usable token. ~244 bits of entropy, so the hash needs no salt/KDF.
  const desktop_token = crypto.randomUUID() + '-' + crypto.randomUUID();
  const desktop_token_hash = await sha256Hex(desktop_token);
  const desktop_token_created_at = new Date().toISOString();

  // Encrypt the IG access token at rest (AES-256-GCM). A D1 read alone can't yield
  // a usable publish-capable token without TOKEN_ENC_KEY.
  const access_token_enc = await encryptToken(access_token, env);

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ig_tokens
         (ig_user_id, access_token, token_expiry, updated_at, desktop_token, desktop_token_created_at,
          whop_license_key, whop_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ig_user_id, access_token_enc, token_expiry, updated_at, desktop_token_hash, desktop_token_created_at,
      license_key, licenseCheck.membershipId,
    ).run();
  } catch (err) {
    console.error('D1 upsert error (ig_tokens):', { message: err?.message });
    return json({ ok: false, error: 'Could not store token' }, 500);
  }

  // Fetch the handle + profile picture for display. Non-fatal: the connection is already
  // stored, so a failed lookup must not fail the whole call — the desktop just shows no
  // @handle / no avatar. (profile_picture_url is why the connected-account icon was blank:
  // the desktop can't fetch it itself — the access token lives here, server-side.)
  let username = null;
  let profile_picture_url = null;
  try {
    const meUrl = new URL('https://graph.instagram.com/v22.0/me');
    meUrl.searchParams.set('fields', 'username,profile_picture_url');
    meUrl.searchParams.set('access_token', access_token);
    const meRes = await fetch(meUrl.toString());
    if (meRes.ok) {
      const me = await meRes.json();
      username = me.username || null;
      profile_picture_url = me.profile_picture_url || null;
    } else {
      console.error('IG me fetch non-OK:', meRes.status);
    }
  } catch (err) {
    console.error('IG me fetch failed (non-fatal):', err);
  }

  // Return the desktop_token — the desktop stores this in Electron safeStorage and
  // uses it as Authorization: Bearer <desktop_token> on all subsequent API calls.
  // The shared API_SECRET is no longer needed by the desktop after this point.
  // media_slug is the opaque prefix the desktop must use when building media keys, so
  // the raw ig_user_id never appears in a public media URL. The desktop cannot derive it
  // (it has no API_SECRET, and must not), so the server hands it over once at connect
  // time and the desktop stores it beside the token in safeStorage.
  const media_slug = await mediaSlug(env, ig_user_id);

  return json({ ok: true, ig_user_id, username, profile_picture_url, desktop_token, media_slug, expires_in_days: Math.floor(expires_in / 86400) });
}
