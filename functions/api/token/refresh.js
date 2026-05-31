const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-secret',
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

  // Shared-secret auth — desktop app (or cron worker) must send x-api-secret
  if (request.headers.get('x-api-secret') !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { ig_user_id } = body;

  if (!ig_user_id) {
    return json({ ok: false, error: 'ig_user_id is required' }, 400);
  }

  // Look up the stored token
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT access_token FROM ig_tokens WHERE ig_user_id = ?`
    ).bind(ig_user_id).first();
  } catch (err) {
    console.error('D1 lookup error (ig_tokens):', err);
    return json({ ok: false, error: 'Could not read token from database' }, 500);
  }

  if (!row) {
    return json({ ok: false, error: 'No token found for this ig_user_id' }, 404);
  }

  // Refresh the long-lived token via Instagram Graph API
  let igData;
  try {
    const refreshUrl = new URL('https://graph.instagram.com/refresh_access_token');
    refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
    refreshUrl.searchParams.set('access_token', row.access_token);

    const igRes = await fetch(refreshUrl.toString());
    igData = await igRes.json();

    if (!igRes.ok || !igData.access_token) {
      const errMsg = igData?.error?.message || igData?.error_message || 'Token refresh failed';
      console.error('IG token refresh error:', igData);
      return json({ ok: false, error: errMsg }, 502);
    }
  } catch (err) {
    console.error('Fetch error during IG token refresh:', err);
    return json({ ok: false, error: 'Failed to reach Instagram API' }, 502);
  }

  const { access_token, expires_in } = igData;
  const expiryDate = new Date(Date.now() + expires_in * 1000);
  const token_expiry = expiryDate.toISOString();
  const updated_at = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ig_tokens (ig_user_id, access_token, token_expiry, updated_at)
       VALUES (?, ?, ?, ?)`
    ).bind(ig_user_id, access_token, token_expiry, updated_at).run();
  } catch (err) {
    console.error('D1 upsert error (ig_tokens) on refresh:', err);
    return json({ ok: false, error: 'Could not store refreshed token' }, 500);
  }

  return json({ ok: true, expires_in_days: Math.floor(expires_in / 86400) });
}
