/**
 * /api/tiktok/{action} — the web app's TikTok connection and posting routes.
 *
 *   GET  auth-url     ?redirect_uri= (optional) → { url }  TikTok authorize URL, state signed for this membership
 *   POST exchange     { code, state, redirect_uri? } → stores encrypted tokens. The web page (/oauth/tiktok/)
 *                     and the desktop app (its 127.0.0.1 loopback) both end here: the TOKEN LIVES IN THE CLOUD
 *   GET  me           → { connected, creator? }  account name + the options it allows
 *   POST post         → starts a direct post (video FILE_UPLOAD, or photos PULL_FROM_URL)
 *   PUT  upload       ?target=<TikTok upload_url> — forwards one chunk to TikTok
 *   GET  status       ?publish_id=
 *   POST disconnect   → revokes at TikTok and deletes the stored tokens
 *
 * AUTH is the Whop licence in the bearer header, same as /api/kits; the membership id is the
 * owner key. Tokens are AES-GCM encrypted at rest (_crypto.js). Nothing here logs a token.
 *
 * WHY CHUNKS GO THROUGH `upload` AND NOT STRAIGHT FROM THE BROWSER: TikTok's upload host does
 * not promise CORS for browser PUTs. The proxy is a pure pass-through (no hashing, no CPU), and
 * it only ever forwards to an https *.tiktokapis.com host so it cannot be pointed elsewhere.
 */

import { checkWhopLicense } from '../_whop.js';
import { encryptToken, decryptToken } from '../_crypto.js';
import {
  signState, verifyState, authorizeUrl, exchangeCode, refreshAccess, revoke,
  queryCreator, initVideoPost, initPhotoPost, fetchStatus, fetchUserInfo, isAllowedUploadUrl, resolveRedirectUri,
} from '../_tiktok.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Range',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function bearer(request) {
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  return m ? m[1].trim() : '';
}

const iso = (ms) => new Date(ms).toISOString();

async function saveConnection(env, membershipId, tokens, displayName) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tiktok_connections
       (membership_id, open_id, display_name, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(membership_id) DO UPDATE SET
       open_id = excluded.open_id,
       display_name = COALESCE(excluded.display_name, tiktok_connections.display_name),
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       scope = excluded.scope,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    membershipId,
    tokens.open_id,
    displayName || null,
    await encryptToken(tokens.access_token, env),
    await encryptToken(tokens.refresh_token, env),
    iso(now + (tokens.expires_in || 86400) * 1000),
    iso(now + (tokens.refresh_expires_in || 31536000) * 1000),
    tokens.scope || null,
  ).run();
}

/** A usable access token for this membership, refreshed (and re-saved) if it is about to lapse. */
async function accessTokenFor(env, membershipId) {
  const row = await env.DB.prepare(`SELECT * FROM tiktok_connections WHERE membership_id = ?`).bind(membershipId).first();
  if (!row) return null;
  if (Date.parse(row.expires_at) - Date.now() > 60 * 1000) return { row, accessToken: await decryptToken(row.access_token_enc, env) };
  const fresh = await refreshAccess(await decryptToken(row.refresh_token_enc, env), env);
  await saveConnection(env, membershipId, fresh, row.display_name);
  return { row, accessToken: fresh.access_token };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const licenceKey = bearer(request);
  if (!licenceKey) return json({ ok: false, error: 'a licence key is required' }, 401);
  const licence = await checkWhopLicense(licenceKey, env);
  if (!licence.ok) return json({ ok: false, error: licence.error }, licence.status);
  const member = licence.membershipId;

  const url = new URL(request.url);
  const action = params.action;

  try {
    if (action === 'auth-url' && request.method === 'GET') {
      const redirectUri = resolveRedirectUri(url.searchParams.get('redirect_uri'));
      if (!redirectUri) return json({ ok: false, error: 'Unsupported redirect_uri' }, 400);
      return json({ ok: true, url: authorizeUrl(await signState(member, env), env, redirectUri) });
    }

    if (action === 'exchange' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const verified = await verifyState(body.state, env);
      // The state must have been minted for THIS licence: otherwise someone could finish a
      // connection onto another customer's membership.
      if (!verified.ok || verified.membershipId !== member || !body.code) {
        return json({ ok: false, error: 'Invalid or expired connection request — start again' }, 400);
      }
      const redirectUri = resolveRedirectUri(body.redirect_uri);
      if (!redirectUri) return json({ ok: false, error: 'Unsupported redirect_uri' }, 400);
      const tokens = await exchangeCode(body.code, env, fetch, redirectUri);
      const info = await fetchUserInfo(tokens.access_token);
      await saveConnection(env, member, tokens, info.display_name);
      return json({ ok: true, display_name: info.display_name || null });
    }

    if (action === 'me' && request.method === 'GET') {
      const conn = await accessTokenFor(env, member);
      if (!conn) return json({ ok: true, connected: false });
      const creator = await queryCreator(conn.accessToken);
      return json({ ok: true, connected: true, display_name: conn.row.display_name, creator });
    }

    if (action === 'post' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const conn = await accessTokenFor(env, member);
      if (!conn) return json({ ok: false, error: 'TikTok is not connected' }, 409);
      if (!body.privacy_level) return json({ ok: false, error: 'Choose who can see this post' }, 400);
      const out = body.kind === 'photo'
        ? await initPhotoPost(conn.accessToken, body)
        : await initVideoPost(conn.accessToken, body);
      return json({ ok: true, ...out });
    }

    if (action === 'upload' && request.method === 'PUT') {
      const target = url.searchParams.get('target') || '';
      if (!isAllowedUploadUrl(target)) return json({ ok: false, error: 'Invalid upload target' }, 400);
      const bytes = await request.arrayBuffer();
      const headers = { 'Content-Type': request.headers.get('X-Content-Type') || 'video/mp4' };
      const range = request.headers.get('Content-Range');
      if (range) headers['Content-Range'] = range;
      const res = await fetch(target, { method: 'PUT', headers, body: bytes });
      return json({ ok: res.ok || res.status === 206, status: res.status }, res.ok || res.status === 206 ? 200 : 502);
    }

    if (action === 'status' && request.method === 'GET') {
      const conn = await accessTokenFor(env, member);
      if (!conn) return json({ ok: false, error: 'TikTok is not connected' }, 409);
      const out = await fetchStatus(conn.accessToken, url.searchParams.get('publish_id') || '');
      return json({ ok: true, ...out });
    }

    if (action === 'disconnect' && request.method === 'POST') {
      const conn = await accessTokenFor(env, member);
      if (conn) {
        try { await revoke(conn.accessToken, env); } catch (err) { console.error('tiktok revoke failed', { message: err?.message }); }
        await env.DB.prepare(`DELETE FROM tiktok_connections WHERE membership_id = ?`).bind(member).run();
      }
      return json({ ok: true });
    }
  } catch (err) {
    // TikTok's own error text is safe to show; it never contains our credentials.
    console.error('tiktok route failed', { action, message: err?.message });
    return json({ ok: false, error: err?.message || 'TikTok request failed' }, 502);
  }

  return json({ ok: false, error: 'Unknown action' }, 404);
}
