import { requireUserAuth } from './_auth.js';
import { decryptToken } from './_crypto.js';

// Instagram Graph host — matches token.js's /me call version.
const GRAPH_BASE = 'https://graph.instagram.com/v22.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// GET /api/connection — "is my stored IG token still publish-valid?"
//
// The desktop calls this before firing the first scheduled post so a creator hits
// a clear "reconnect Instagram" prompt at their keyboard instead of discovering a
// dead token hours later when the cron worker silently marks a post TOKEN_EXPIRED.
//
// It probes /{ig_user_id}/content_publishing_limit — that endpoint needs BOTH a
// live token AND the content-publish permission, so a 200 proves the token can
// actually publish, not merely that it authenticates. Read-only: touches no rows.
//
// Returns 200 with a status object for every *connection* state (connected or not,
// publishable or not). Reserves { ok:false } + non-200 for real server faults
// (DB/decrypt), so the desktop can branch on `publishable` without parsing errors.
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT access_token, token_expiry FROM ig_tokens WHERE ig_user_id = ?`
    )
      .bind(ig_user_id)
      .first();
  } catch (err) {
    console.error('D1 select error (connection):', { message: err?.message });
    return json({ ok: false, error: 'Could not look up connection' }, 500);
  }

  // No token stored — the account was never connected, or the desktop token was
  // revoked. Not an error; a legitimate "reconnect" answer.
  if (!row || !row.access_token) {
    return json({ ok: true, connected: false, publishable: false, reason: 'not_connected' });
  }

  const expires_at = row.token_expiry ?? null;

  let accessToken;
  try {
    accessToken = await decryptToken(row.access_token, env);
  } catch (err) {
    console.error('Token decrypt failed (connection):', { message: err?.message });
    return json({ ok: false, error: 'Could not read stored token' }, 500);
  }

  // Live probe. content_publishing_limit fails with Meta code 190 on an
  // expired/invalid token and with a permission error if the publish scope was
  // never granted or was revoked in the creator's Meta settings.
  let data;
  try {
    const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(ig_user_id)}/content_publishing_limit`);
    url.searchParams.set('fields', 'quota_usage,config');
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString());
    data = await res.json();

    if (!res.ok || data?.error) {
      // Scalar-only log — never serialize `data` (can echo the token back in some errors).
      const code = data?.error?.code;
      console.error('IG content_publishing_limit non-OK:', { status: res.status, code });
      const reason = code === 190 ? 'token_invalid' : 'permission';
      return json({ ok: true, connected: true, publishable: false, reason, expires_at });
    }
  } catch (err) {
    // Couldn't reach Meta — the token may be fine; report the check itself failed
    // so the desktop can retry rather than telling the creator to reconnect.
    console.error('IG content_publishing_limit network error:', { message: err?.message });
    return json({ ok: true, connected: true, publishable: null, reason: 'check_failed', expires_at });
  }

  // Publish-valid. Surface the rolling 24h quota so the desktop can warn before a
  // large batch trips Meta's 50-posts/day ceiling.
  const bucket = Array.isArray(data.data) ? data.data[0] : undefined;
  const quota_usage = bucket?.quota_usage ?? null;
  const quota_total = bucket?.config?.quota_total ?? null;

  return json({
    ok: true,
    connected: true,
    publishable: true,
    expires_at,
    quota_usage,
    quota_total,
  });
}
