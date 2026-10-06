/**
 * /api/youtube/{action} — the creator's YouTube (Google) REFRESH token, held in the cloud.
 *
 *   POST exchange      { code, code_verifier, redirect_uri } → stores the refresh token
 *                      (encrypted, D1), returns { access_token, expires_in, channel } — NEVER the
 *                      refresh token
 *   POST access-token  { channel_id? } → a fresh short-lived access token
 *   GET  me            → { connected, channel? }
 *   POST disconnect    { channel_id? } → revokes at Google, deletes the row
 *
 * WHY: the rule is "no tokens kept locally". The desktop used to hold the refresh token in the OS
 * keychain and exchange/refresh it through /api/google/token. Now the long-lived credential never
 * leaves the cloud. The desktop still receives a ~1 hour ACCESS token, because it uploads the video
 * straight to YouTube (a multi-GB resumable upload is not something to proxy through a Function);
 * that token expires on its own and cannot mint another.
 *
 * AUTH is the Whop licence in the bearer header (same as /api/kits); membership id is the owner key.
 * PKCE is required on exchange, and the redirect must be the desktop's own loopback, so a stolen
 * authorization code cannot be redeemed through this route by anyone else.
 */

import { checkWhopLicense } from '../_whop.js';
import { encryptToken, decryptToken } from '../_crypto.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
// The desktop's registered Google loopback (electron-shell/main.js OAUTH_REDIRECT_URI).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback\/?$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function bearer(request) {
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  return m ? m[1].trim() : '';
}

async function googleToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !data.error, status: res.status, data };
}

async function channelOf(accessToken) {
  try {
    const res = await fetch(CHANNELS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    const c = data?.items?.[0];
    if (!c) return null;
    return { id: c.id, title: c.snippet?.title || null, thumbnail: c.snippet?.thumbnails?.default?.url || null };
  } catch {
    return null;
  }
}

async function findRow(env, member, channelId) {
  return channelId
    ? env.DB.prepare(`SELECT * FROM youtube_connections WHERE membership_id = ? AND channel_id = ?`).bind(member, channelId).first()
    : env.DB.prepare(`SELECT * FROM youtube_connections WHERE membership_id = ? ORDER BY updated_at DESC LIMIT 1`).bind(member).first();
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const licenceKey = bearer(request);
  if (!licenceKey) return json({ ok: false, error: 'a licence key is required' }, 401);
  const licence = await checkWhopLicense(licenceKey, env);
  if (!licence.ok) return json({ ok: false, error: licence.error }, licence.status);
  const member = licence.membershipId;
  const action = params.action;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ ok: false, error: 'server is missing Google credentials' }, 503);
  }

  try {
    if (action === 'exchange' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) || {};
      if (!body.code || !body.code_verifier) return json({ ok: false, error: 'code and code_verifier are required' }, 400);
      if (!LOOPBACK.test(String(body.redirect_uri || ''))) return json({ ok: false, error: 'Unsupported redirect_uri' }, 400);

      const t = await googleToken({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri,
      });
      if (!t.ok) return json({ ok: false, error: t.data.error_description || t.data.error || 'Google rejected the code' }, 502);
      if (!t.data.refresh_token) {
        // Google only returns one on first consent (or with prompt=consent). Without it there is
        // nothing durable to keep, so say so instead of "connecting" a channel that dies in an hour.
        return json({ ok: false, error: 'Google did not return a refresh token — reconnect and approve access again' }, 502);
      }
      const channel = await channelOf(t.data.access_token);
      if (!channel) return json({ ok: false, error: 'Could not read your YouTube channel' }, 502);

      await env.DB.prepare(
        `INSERT INTO youtube_connections (membership_id, channel_id, channel_title, refresh_token_enc, scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(membership_id, channel_id) DO UPDATE SET
           channel_title = excluded.channel_title,
           refresh_token_enc = excluded.refresh_token_enc,
           scope = excluded.scope,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).bind(member, channel.id, channel.title, await encryptToken(t.data.refresh_token, env), t.data.scope || null).run();

      return json({ ok: true, access_token: t.data.access_token, expires_in: t.data.expires_in, channel });
    }

    if (action === 'access-token' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) || {};
      const row = await findRow(env, member, body.channel_id);
      if (!row) return json({ ok: false, error: 'YouTube is not connected' }, 409);
      const t = await googleToken({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: await decryptToken(row.refresh_token_enc, env),
      });
      if (!t.ok) {
        if (t.data.error === 'invalid_grant') {
          // Revoked or expired at Google: the stored token is dead, so drop it and make the
          // desktop show "reconnect" instead of retrying forever.
          await env.DB.prepare(`DELETE FROM youtube_connections WHERE membership_id = ? AND channel_id = ?`).bind(member, row.channel_id).run();
          return json({ ok: false, error: 'YouTube access was revoked — reconnect', reconnect: true }, 409);
        }
        return json({ ok: false, error: t.data.error_description || 'Could not refresh YouTube access' }, 502);
      }
      return json({ ok: true, access_token: t.data.access_token, expires_in: t.data.expires_in, channel_id: row.channel_id });
    }

    if (action === 'me' && request.method === 'GET') {
      const row = await findRow(env, member, null);
      if (!row) return json({ ok: true, connected: false });
      return json({ ok: true, connected: true, channel: { id: row.channel_id, title: row.channel_title } });
    }

    if (action === 'disconnect' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) || {};
      const row = await findRow(env, member, body.channel_id);
      if (row) {
        try {
          await fetch(REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: await decryptToken(row.refresh_token_enc, env) }).toString(),
          });
        } catch (err) { console.error('youtube revoke failed', { message: err?.message }); }
        await env.DB.prepare(`DELETE FROM youtube_connections WHERE membership_id = ? AND channel_id = ?`).bind(member, row.channel_id).run();
      }
      return json({ ok: true });
    }
  } catch (err) {
    console.error('youtube route failed', { action, message: err?.message });
    return json({ ok: false, error: 'YouTube request failed' }, 502);
  }

  return json({ ok: false, error: 'Unknown action' }, 404);
}
