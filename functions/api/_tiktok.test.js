// Run with: node --test functions/api/_tiktok.test.js
// TikTok Login Kit + Content Posting API client. Every call goes through an injected fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  REDIRECT_URI, SCOPES, authorizeUrl, signState, verifyState,
  exchangeCode, refreshAccess, queryCreator, initVideoPost, initPhotoPost,
  fetchStatus, revoke, isAllowedUploadUrl, resolveRedirectUri,
} from './_tiktok.js';

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const env = { TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', API_SECRET: 'state-secret' };
const ok = (data) => async () => ({ ok: true, status: 200, json: async () => data });
const record = (data) => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => data }; };
  return { f, calls };
};

test('redirect URI is the exact trailing-slash form TikTok will match', () => {
  assert.equal(REDIRECT_URI, 'https://brandgita.com/oauth/tiktok/');
});

test('state round-trips and carries the membership', async () => {
  const state = await signState('mem_1', env);
  const out = await verifyState(state, env);
  assert.equal(out.ok, true);
  assert.equal(out.membershipId, 'mem_1');
});

test('a tampered state is rejected', async () => {
  const state = await signState('mem_1', env);
  const bad = state.replace('mem_1', 'mem_2');
  assert.equal((await verifyState(bad, env)).ok, false);
  assert.equal((await verifyState('garbage', env)).ok, false);
});

test('an expired state is rejected', async () => {
  const state = await signState('mem_1', env, Date.now() - 20 * 60 * 1000);
  assert.equal((await verifyState(state, env)).ok, false);
});

test('authorize URL carries client key, scopes, redirect and state', () => {
  const u = new URL(authorizeUrl('STATE', env));
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'STATE');
  assert.equal(u.searchParams.get('scope'), SCOPES.join(','));
  assert.ok(SCOPES.includes('video.publish') && SCOPES.includes('user.info.basic'));
});

test('exchangeCode posts the code with the same redirect_uri and returns tokens', async () => {
  const { f, calls } = record({ access_token: 'a', refresh_token: 'r', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'user.info.basic' });
  const out = await exchangeCode('CODE', env, f);
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'CODE');
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(body.get('client_secret'), 'cs');
  assert.equal(out.access_token, 'a');
  assert.equal(out.open_id, 'o');
});

test('exchangeCode surfaces a TikTok error without leaking the secret', async () => {
  const f = ok({ error: 'invalid_grant', error_description: 'Authorization code is expired.' });
  await assert.rejects(exchangeCode('CODE', env, f), (e) => /invalid_grant/.test(e.message) && !/cs/.test(e.message));
});

test('refreshAccess uses the refresh_token grant', async () => {
  const { f, calls } = record({ access_token: 'a2', refresh_token: 'r2', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o' });
  await refreshAccess('R', env, f);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'R');
});

test('queryCreator returns the options the account allows', async () => {
  const { f, calls } = record({ data: { creator_nickname: 'Utsav', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
  const out = await queryCreator('AT', f);
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer AT');
  assert.equal(out.creator_nickname, 'Utsav');
  assert.deepEqual(out.privacy_level_options, ['SELF_ONLY', 'PUBLIC_TO_EVERYONE']);
});

test('initVideoPost: no default privacy — a missing choice is refused before any call', async () => {
  const { f, calls } = record({});
  await assert.rejects(initVideoPost('AT', { title: 't', video_size: 10, chunk_size: 10, total_chunk_count: 1 }, f), /privacy/i);
  assert.equal(calls.length, 0);
});

test('initVideoPost sends the creator\'s choices and file-upload source', async () => {
  const { f, calls } = record({ data: { publish_id: 'p1', upload_url: 'https://open-upload.tiktokapis.com/video/?x=1' }, error: { code: 'ok' } });
  const out = await initVideoPost('AT', {
    title: 'hello', privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true,
    brand_content_toggle: false, brand_organic_toggle: true, video_size: 30, chunk_size: 30, total_chunk_count: 1,
  }, f);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/video/init/');
  assert.equal(sent.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(sent.post_info.disable_comment, true);
  assert.equal(sent.post_info.brand_organic_toggle, true);
  assert.equal(sent.source_info.source, 'FILE_UPLOAD');
  assert.equal(sent.source_info.video_size, 30);
  assert.equal(out.publish_id, 'p1');
});

test('initPhotoPost pulls images from the allowed asset host only', async () => {
  const { f, calls } = record({ data: { publish_id: 'p2' }, error: { code: 'ok' } });
  await initPhotoPost('AT', { title: 't', privacy_level: 'SELF_ONLY', image_urls: ['https://assets.brandgita.com/tiktok/abc/1.jpg'] }, f);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/content/init/');
  assert.equal(sent.media_type, 'PHOTO');
  assert.equal(sent.post_mode, 'DIRECT_POST');
  assert.equal(sent.source_info.source, 'PULL_FROM_URL');
  await assert.rejects(initPhotoPost('AT', { title: 't', privacy_level: 'SELF_ONLY', image_urls: ['https://evil.example.com/1.jpg'] }, f), /assets\.brandgita\.com/);
});

test('fetchStatus and revoke hit the documented endpoints', async () => {
  const s = record({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } });
  const out = await fetchStatus('AT', 'p1', s.f);
  assert.equal(s.calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/status/fetch/');
  assert.equal(out.status, 'PUBLISH_COMPLETE');
  const r = record({});
  await revoke('AT', env, r.f);
  assert.equal(r.calls[0].url, 'https://open.tiktokapis.com/v2/oauth/revoke/');
});

test('only TikTok upload hosts are accepted as an upload target', () => {
  assert.equal(isAllowedUploadUrl('https://open-upload.tiktokapis.com/video/?x=1'), true);
  assert.equal(isAllowedUploadUrl('http://open-upload.tiktokapis.com/video/'), false);
  assert.equal(isAllowedUploadUrl('https://evil.example.com/video/'), false);
  assert.equal(isAllowedUploadUrl('https://tiktokapis.com.evil.com/'), false);
  assert.equal(isAllowedUploadUrl('not a url'), false);
});

test('redirect URI: the web page, or the desktop loopback, and nothing else', () => {
  assert.equal(resolveRedirectUri(undefined), REDIRECT_URI);
  assert.equal(resolveRedirectUri(''), REDIRECT_URI);
  assert.equal(resolveRedirectUri('http://127.0.0.1:9877/callback/'), 'http://127.0.0.1:9877/callback/');
  assert.equal(resolveRedirectUri('http://127.0.0.1:51234/callback/'), 'http://127.0.0.1:51234/callback/');
  for (const bad of ['http://evil.example.com/callback/', 'https://127.0.0.1:9877/callback/', 'http://127.0.0.1:9877/other/', 'http://127.0.0.1.evil.com:9877/callback/', 'http://localhost:9877/callback/', 'javascript:alert(1)']) {
    assert.equal(resolveRedirectUri(bad), null, bad);
  }
});

test('exchangeCode and authorizeUrl use the redirect URI they are given (desktop loopback)', async () => {
  const lb = 'http://127.0.0.1:9877/callback/';
  assert.equal(new URL(authorizeUrl('S', env, lb)).searchParams.get('redirect_uri'), lb);
  const { f, calls } = record({ access_token: 'a', refresh_token: 'r', expires_in: 1, refresh_expires_in: 1, open_id: 'o' });
  await exchangeCode('C', env, f, lb);
  assert.equal(new URLSearchParams(calls[0].init.body).get('redirect_uri'), lb);
});

test('PKCE passes through: the challenge goes on the authorize URL, the verifier on the exchange', async () => {
  const u = new URL(authorizeUrl('S', env, REDIRECT_URI, 'abc123'));
  assert.equal(u.searchParams.get('code_challenge'), 'abc123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(authorizeUrl('S', env)).searchParams.get('code_challenge'), null);
  const { f, calls } = record({ access_token: 'a', refresh_token: 'r', expires_in: 1, refresh_expires_in: 1, open_id: 'o' });
  await exchangeCode('C', env, f, REDIRECT_URI, 'verifier-xyz');
  assert.equal(new URLSearchParams(calls[0].init.body).get('code_verifier'), 'verifier-xyz');
  const g = record({ access_token: 'a', refresh_token: 'r', expires_in: 1, refresh_expires_in: 1, open_id: 'o' });
  await exchangeCode('C', env, g.f);
  assert.equal(new URLSearchParams(g.calls[0].init.body).get('code_verifier'), null);
});
