/**
 * TikTok Login Kit (web) + Content Posting API client.
 *
 * Every network call takes an injected `fetchImpl` so tests never touch TikTok. Nothing here
 * logs a token or the client secret; errors carry TikTok's own error code and description only.
 *
 * REDIRECT_URI keeps its trailing slash on purpose: TikTok matches the registered redirect
 * URI exactly, and Pages 308-redirects /oauth/tiktok to /oauth/tiktok/ — so the slash form is
 * the one the browser actually lands on and the one that must be registered.
 */

export const REDIRECT_URI = 'https://brandgita.com/oauth/tiktok/';
export const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
export const ASSET_HOST = 'assets.brandgita.com';

const API = 'https://open.tiktokapis.com';
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

// ── CSRF state: bound to the membership, signed, short-lived ─────────────────
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `w1.<membership>.<ts>.<nonce>.<mac>` — the `w1.` prefix tells the return page this is a web
 * connection, not the desktop loopback handoff. Membership ids contain no dots. */
export async function signState(membershipId, env, now = Date.now()) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const body = `w1.${membershipId}.${now}.${nonce}`;
  return `${body}.${await hmacHex(env.API_SECRET, body)}`;
}

export async function verifyState(state, env, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'w1') return { ok: false };
  const [, membershipId, ts, nonce, mac] = parts;
  const expected = await hmacHex(env.API_SECRET, `w1.${membershipId}.${ts}.${nonce}`);
  if (mac.length !== expected.length) return { ok: false };
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return { ok: false };
  const age = now - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > STATE_MAX_AGE_MS) return { ok: false };
  return { ok: true, membershipId };
}

/** Which redirect URI a connection uses: the registered web page (default), or the desktop
 * app's own loopback (`http://127.0.0.1:<port>/callback/`, registered with TikTok as a
 * wildcard-port loopback entry). Anything else is refused so a caller cannot send the
 * authorization code to a host of its choosing. The same value must be used for the authorize
 * request and the token exchange — TikTok compares them. */
export function resolveRedirectUri(value) {
  if (!value) return REDIRECT_URI;
  if (value === REDIRECT_URI) return REDIRECT_URI;
  return /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback\/$/.test(value) ? value : null;
}

export function authorizeUrl(state, env, redirectUri = REDIRECT_URI, codeChallenge = '') {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  // PKCE (desktop clients). The CLIENT creates the verifier and computes the challenge in the
  // format TikTok requires; this side only passes both through and never sees the verifier
  // until the exchange.
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

// ── OAuth token calls ───────────────────────────────────────────────────────
async function tokenCall(params, fetchImpl) {
  const res = await fetchImpl(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error || !data.access_token) {
    throw new Error(`TikTok token error: ${data.error || 'no_token'} — ${data.error_description || 'unknown'}`);
  }
  return data;
}

export const exchangeCode = (code, env, fetchImpl = fetch, redirectUri = REDIRECT_URI, codeVerifier = '') =>
  tokenCall({
    client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
    code, grant_type: 'authorization_code', redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  }, fetchImpl);

export const refreshAccess = (refreshToken, env, fetchImpl = fetch) =>
  tokenCall({
    client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }, fetchImpl);

export async function revoke(accessToken, env, fetchImpl = fetch) {
  await fetchImpl(`${API}/v2/oauth/revoke/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: accessToken }).toString(),
  });
}

// ── Content Posting API ─────────────────────────────────────────────────────
async function apiCall(path, accessToken, body, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error && data.error.code && data.error.code !== 'ok') {
    throw new Error(`TikTok API error: ${data.error.code} — ${data.error.message || 'unknown'}`);
  }
  return data.data || {};
}

/** The account's name and the options it allows. Called before every post screen renders. */
export const queryCreator = (accessToken, fetchImpl = fetch) =>
  apiCall('/v2/post/publish/creator_info/query/', accessToken, {}, fetchImpl);

function postInfo(p) {
  // No default privacy: TikTok's UX rules require the creator to pick, so a missing choice is
  // refused here rather than quietly filled in.
  if (!p.privacy_level) throw new Error('privacy_level is required — the creator must choose who can see the post');
  return {
    title: p.title || '',
    privacy_level: p.privacy_level,
    disable_comment: p.disable_comment !== false,
    disable_duet: p.disable_duet !== false,
    disable_stitch: p.disable_stitch !== false,
    brand_content_toggle: p.brand_content_toggle === true,
    brand_organic_toggle: p.brand_organic_toggle === true,
  };
}

export async function initVideoPost(accessToken, p, fetchImpl = fetch) {
  const post_info = postInfo(p);
  return apiCall('/v2/post/publish/video/init/', accessToken, {
    post_info,
    source_info: { source: 'FILE_UPLOAD', video_size: p.video_size, chunk_size: p.chunk_size, total_chunk_count: p.total_chunk_count },
  }, fetchImpl);
}

export async function initPhotoPost(accessToken, p, fetchImpl = fetch) {
  const urls = Array.isArray(p.image_urls) ? p.image_urls : [];
  if (urls.length === 0) throw new Error('at least one image is required');
  for (const u of urls) {
    let host = '';
    try { const x = new URL(u); host = x.protocol === 'https:' ? x.hostname : ''; } catch { /* invalid */ }
    if (host !== ASSET_HOST) throw new Error(`images must be hosted at ${ASSET_HOST}`);
  }
  const info = postInfo(p);
  return apiCall('/v2/post/publish/content/init/', accessToken, {
    post_info: { title: info.title, description: p.description || '', privacy_level: info.privacy_level, disable_comment: info.disable_comment, auto_add_music: p.auto_add_music === true, brand_content_toggle: info.brand_content_toggle, brand_organic_toggle: info.brand_organic_toggle },
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO',
  }, fetchImpl);
}

export const fetchStatus = (accessToken, publishId, fetchImpl = fetch) =>
  apiCall('/v2/post/publish/status/fetch/', accessToken, { publish_id: publishId }, fetchImpl);

/** The chunk-proxy route may only forward to TikTok's own upload hosts over HTTPS. */
export function isAllowedUploadUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'tiktokapis.com' || u.hostname.endsWith('.tiktokapis.com'));
  } catch {
    return false;
  }
}

/** Display name for the connected account (user.info.basic). Best-effort: a missing name must
 * never fail a connection that otherwise succeeded. */
export async function fetchUserInfo(accessToken, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${API}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    return data?.data?.user || {};
  } catch {
    return {};
  }
}
