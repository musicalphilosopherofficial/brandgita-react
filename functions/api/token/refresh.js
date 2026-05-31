import { requireUserAuth } from '../_auth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  // Per-user bearer auth — ig_user_id is derived from the token, NEVER the body.
  // Previously this accepted a caller-supplied ig_user_id behind the shared
  // API_SECRET, letting any holder of that secret refresh/rotate ANY user's IG
  // token (cross-tenant IDOR). Now a user can only refresh their own.
  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT access_token FROM ig_tokens WHERE ig_user_id = ?`
    ).bind(ig_user_id).first();
  } catch (err) {
    console.error('D1 lookup error (ig_tokens):', { message: err?.message });
    return json({ ok: false, error: 'Could not read token from database' }, 500);
  }

  if (!row) {
    return json({ ok: false, error: 'No token found' }, 404);
  }

  let igData;
  try {
    const refreshUrl = new URL('https://graph.instagram.com/refresh_access_token');
    refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
    refreshUrl.searchParams.set('access_token', row.access_token);

    const igRes = await fetch(refreshUrl.toString());
    igData = await igRes.json();

    if (!igRes.ok || !igData.access_token) {
      // Log ONLY scalar diagnostics — never the raw response (it can carry a token).
      console.error('IG token refresh error:', { status: igRes.status, code: igData?.error?.code });
      return json({ ok: false, error: 'Token refresh failed' }, 502);
    }
  } catch (err) {
    console.error('Fetch error during IG token refresh:', { message: err?.message });
    return json({ ok: false, error: 'Failed to reach Instagram API' }, 502);
  }

  const { access_token, expires_in } = igData;
  const token_expiry = new Date(Date.now() + expires_in * 1000).toISOString();
  const updated_at = new Date().toISOString();

  // UPDATE only the token fields — must NOT touch desktop_token/desktop_token_created_at.
  // (The previous INSERT OR REPLACE wiped the desktop bearer token to NULL on every
  // refresh, breaking the user's auth and forcing a full re-OAuth.)
  try {
    await env.DB.prepare(
      `UPDATE ig_tokens SET access_token = ?, token_expiry = ?, updated_at = ? WHERE ig_user_id = ?`
    ).bind(access_token, token_expiry, updated_at, ig_user_id).run();
  } catch (err) {
    console.error('D1 update error (ig_tokens) on refresh:', { message: err?.message });
    return json({ ok: false, error: 'Could not store refreshed token' }, 500);
  }

  return json({ ok: true, expires_in_days: Math.floor(expires_in / 86400) });
}
