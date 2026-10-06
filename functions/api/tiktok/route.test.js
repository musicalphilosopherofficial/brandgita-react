// Run with: node --test functions/api/tiktok/route.test.js
// /api/tiktok/{action} — the web app's TikTok connect + post routes, against fake Whop, TikTok and D1.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { onRequest } from './[action].js';
import { signState } from '../_tiktok.js';

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const KEY = Buffer.alloc(32, 7).toString('base64');
let rows, tiktokCalls, tiktokReplies;

function makeEnv() {
  rows = new Map();
  return {
    API_SECRET: 'state-secret', TOKEN_ENC_KEY: KEY, WHOP_COMPANY_API: 'whop',
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { return /FROM tiktok_connections/.test(sql) ? rows.get(args[0]) ?? null : null; },
              async run() {
                if (/INSERT INTO tiktok_connections/.test(sql)) {
                  rows.set(args[0], { membership_id: args[0], open_id: args[1], display_name: args[2], access_token_enc: args[3], refresh_token_enc: args[4], expires_at: args[5], refresh_expires_at: args[6], scope: args[7] });
                } else if (/DELETE FROM tiktok_connections/.test(sql)) rows.delete(args[0]);
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

beforeEach(() => {
  tiktokCalls = [];
  tiktokReplies = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('whop')) {
      if (u.includes('good-licence')) return { ok: true, status: 200, json: async () => ({ id: 'mem_1', user: 'user_1', valid: true, status: 'active' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    tiktokCalls.push({ url: u, init });
    const reply = Object.entries(tiktokReplies).find(([k]) => u.includes(k));
    return { ok: true, status: 200, json: async () => (reply ? reply[1] : {}), text: async () => '' };
  };
});

const req = (action, { method = 'GET', licence = 'good-licence', body, query = '' } = {}) => ({
  method,
  url: `https://brandgita.com/api/tiktok/${action}${query}`,
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && licence ? `Bearer ${licence}` : null) },
  async json() { return body; },
  async arrayBuffer() { return body || new ArrayBuffer(0); },
});
const call = (env, action, opts) => onRequest({ request: req(action, opts), env, params: { action } });

test('no licence → 401; bad licence → 402', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'me', { licence: '' })).status, 401);
  assert.equal((await call(env, 'me', { licence: 'nope' })).status, 402);
});

test('auth-url returns a TikTok authorize URL carrying a signed state for this membership', async () => {
  const env = makeEnv();
  const res = await call(env, 'auth-url');
  const data = await res.json();
  assert.equal(res.status, 200);
  const u = new URL(data.url);
  assert.equal(u.hostname, 'www.tiktok.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://brandgita.com/oauth/tiktok/');
  assert.match(u.searchParams.get('state'), /^w1\.mem_1\./);
});

test('exchange stores ENCRYPTED tokens for the state\'s membership', async () => {
  const env = makeEnv();
  tiktokReplies['/v2/oauth/token/'] = { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'open1', scope: 'user.info.basic' };
  tiktokReplies['/v2/user/info/'] = { data: { user: { display_name: 'Utsav' } } };
  const state = await signState('mem_1', env);
  const res = await call(env, 'exchange', { method: 'POST', body: { code: 'CODE', state } });
  assert.equal(res.status, 200);
  const row = rows.get('mem_1');
  assert.equal(row.open_id, 'open1');
  assert.equal(row.display_name, 'Utsav');
  assert.ok(row.access_token_enc.startsWith('v1:') && !row.access_token_enc.includes('ACCESS'));
  assert.ok(row.refresh_token_enc.startsWith('v1:') && !row.refresh_token_enc.includes('REFRESH'));
});

test('exchange refuses a state signed for a different membership than the licence', async () => {
  const env = makeEnv();
  const state = await signState('mem_OTHER', env);
  const res = await call(env, 'exchange', { method: 'POST', body: { code: 'CODE', state } });
  assert.equal(res.status, 400);
  assert.equal(rows.size, 0);
  assert.equal(tiktokCalls.length, 0, 'TikTok must not be called with an unverified state');
});

test('me → not connected when there is no row', async () => {
  const env = makeEnv();
  const data = await (await call(env, 'me')).json();
  assert.equal(data.connected, false);
});

test('me → connected, with the account name and the options the account allows', async () => {
  const env = makeEnv();
  tiktokReplies['/v2/oauth/token/'] = { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'open1', scope: 'x' };
  tiktokReplies['/v2/user/info/'] = { data: { user: { display_name: 'Utsav' } } };
  await call(env, 'exchange', { method: 'POST', body: { code: 'C', state: await signState('mem_1', env) } });
  tiktokReplies['/creator_info/query/'] = { data: { creator_nickname: 'Utsav', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false }, error: { code: 'ok' } };
  const data = await (await call(env, 'me')).json();
  assert.equal(data.connected, true);
  assert.equal(data.creator.creator_nickname, 'Utsav');
  assert.deepEqual(data.creator.privacy_level_options, ['SELF_ONLY']);
});

test('post without a privacy choice is refused (no default)', async () => {
  const env = makeEnv();
  tiktokReplies['/v2/oauth/token/'] = { access_token: 'A', refresh_token: 'R', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o' };
  await call(env, 'exchange', { method: 'POST', body: { code: 'C', state: await signState('mem_1', env) } });
  const res = await call(env, 'post', { method: 'POST', body: { kind: 'video', title: 't', video_size: 5, chunk_size: 5, total_chunk_count: 1 } });
  assert.equal(res.status, 400);
});

test('upload proxy refuses a non-TikTok target', async () => {
  const env = makeEnv();
  const res = await call(env, 'upload', { method: 'PUT', query: `?target=${encodeURIComponent('https://evil.example.com/x')}`, body: new ArrayBuffer(4) });
  assert.equal(res.status, 400);
  assert.equal(tiktokCalls.length, 0);
});

test('disconnect revokes at TikTok and deletes the stored row', async () => {
  const env = makeEnv();
  tiktokReplies['/v2/oauth/token/'] = { access_token: 'A', refresh_token: 'R', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o' };
  await call(env, 'exchange', { method: 'POST', body: { code: 'C', state: await signState('mem_1', env) } });
  assert.equal(rows.size, 1);
  const res = await call(env, 'disconnect', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(rows.size, 0);
  assert.ok(tiktokCalls.some((c) => c.url.includes('/v2/oauth/revoke/')));
});
