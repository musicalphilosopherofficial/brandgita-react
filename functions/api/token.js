import { sha256Hex, requireUserAuth } from './_auth.js';

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

  // Shared-secret auth — desktop app must send x-api-secret
  if (request.headers.get('x-api-secret') !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
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

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ig_tokens
         (ig_user_id, access_token, token_expiry, updated_at, desktop_token, desktop_token_created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(ig_user_id, access_token, token_expiry, updated_at, desktop_token_hash, desktop_token_created_at).run();
  } catch (err) {
    console.error('D1 upsert error (ig_tokens):', { message: err?.message });
    return json({ ok: false, error: 'Could not store token' }, 500);
  }

  // Fetch the handle for display. Non-fatal: the connection is already stored, so a
  // failed username lookup must not fail the whole call — the desktop just shows no @handle.
  let username = null;
  try {
    const meUrl = new URL('https://graph.instagram.com/v22.0/me');
    meUrl.searchParams.set('fields', 'username');
    meUrl.searchParams.set('access_token', access_token);
    const meRes = await fetch(meUrl.toString());
    if (meRes.ok) {
      const me = await meRes.json();
      username = me.username || null;
    } else {
      console.error('IG username fetch non-OK:', meRes.status);
    }
  } catch (err) {
    console.error('IG username fetch failed (non-fatal):', err);
  }

  // Return the desktop_token — the desktop stores this in Electron safeStorage and
  // uses it as Authorization: Bearer <desktop_token> on all subsequent API calls.
  // The shared API_SECRET is no longer needed by the desktop after this point.
  return json({ ok: true, ig_user_id, username, desktop_token, expires_in_days: Math.floor(expires_in / 86400) });
}
