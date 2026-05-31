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

  const { ig_user_id, short_lived_token } = body;

  if (!ig_user_id || !short_lived_token) {
    return json({ ok: false, error: 'ig_user_id and short_lived_token are required' }, 400);
  }

  // Exchange short-lived token for a long-lived token via Instagram Graph API
  let igData;
  try {
    const exchangeUrl = new URL('https://graph.instagram.com/access_token');
    exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
    exchangeUrl.searchParams.set('client_secret', env.IG_CLIENT_SECRET);
    exchangeUrl.searchParams.set('access_token', short_lived_token);

    const igRes = await fetch(exchangeUrl.toString());
    igData = await igRes.json();

    if (!igRes.ok || !igData.access_token) {
      const errMsg = igData?.error?.message || igData?.error_message || 'Token exchange failed';
      console.error('IG token exchange error:', igData);
      return json({ ok: false, error: errMsg }, 502);
    }
  } catch (err) {
    console.error('Fetch error during IG token exchange:', err);
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
    console.error('D1 upsert error (ig_tokens):', err);
    return json({ ok: false, error: 'Could not store token' }, 500);
  }

  return json({ ok: true, expires_in_days: Math.floor(expires_in / 86400) });
}
