// Run with: node --test functions/api/youtube/route.test.js
// /api/youtube/{action} — the YouTube refresh token lives in D1; the desktop only gets access tokens.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { onRequest } from './[action].js';

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const KEY = Buffer.alloc(32, 9).toString('base64');
const LOOPBACK = 'http://127.0.0.1:9877/callback';
let rows, googleCalls, googleReplies;

function makeEnv() {
  rows = new Map();
  return {
    TOKEN_ENC_KEY: KEY, WHOP_COMPANY_API: 'whop',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
    DB: {
      prepare(sql) {
        return {
          bind(...a) {
            return {
              async first() {
                if (/FROM youtube_connections/.test(sql)) {
                  const mine = [...rows.values()].filter((r) => r.membership_id === a[0]);
                  if (a.length > 1) return mine.find((r) => r.channel_id === a[1]) ?? null;
                  return mine[mine.length - 1] ?? null;
                }
                return null;
              },
              async run() {
                if (/INSERT INTO youtube_connections/.test(sql)) {
                  rows.set(`${a[0]}|${a[1]}`, { membership_id: a[0], channel_id: a[1], channel_title: a[2], refresh_token_enc: a[3], scope: a[4] });
                } else if (/DELETE FROM youtube_connections/.test(sql)) rows.delete(`${a[0]}|${a[1]}`);
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
  googleCalls = [];
  googleReplies = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('whop')) {
      return u.includes('good-licence')
        ? { ok: true, status: 200, json: async () => ({ id: 'mem_1', user: 'user_1', valid: true, status: 'active' }) }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    googleCalls.push({ url: u, init });
    const hit = Object.entries(googleReplies).find(([k]) => u.includes(k));
    const status = hit && hit[1].__status ? hit[1].__status : 200;
    return { ok: status < 400, status, json: async () => (hit ? hit[1] : {}) };
  };
});

const req = (action, { method = 'POST', licence = 'good-licence', body, query = '' } = {}) => ({
  method, url: `https://brandgita.com/api/youtube/${action}${query}`,
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && licence ? `Bearer ${licence}` : null) },
  async json() { return body; },
});
const call = (env, action, opts) => onRequest({ request: req(action, opts), env, params: { action } });

const TOKENS = { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600, scope: 'youtube.upload' };
const CHANNEL = { items: [{ id: 'UC1', snippet: { title: 'My Channel', thumbnails: { default: { url: 'https://img/1.jpg' } } } }] };
async function connect(env) {
  googleReplies['oauth2.googleapis.com/token'] = TOKENS;
  googleReplies['youtube/v3/channels'] = CHANNEL;
  return call(env, 'exchange', { body: { code: 'C', code_verifier: 'V', redirect_uri: LOOPBACK } });
}

test('no licence → 401; bad licence → 402', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'me', { method: 'GET', licence: '' })).status, 401);
  assert.equal((await call(env, 'me', { method: 'GET', licence: 'nope' })).status, 402);
});

test('exchange stores the refresh token ENCRYPTED and never returns it to the desktop', async () => {
  const env = makeEnv();
  const res = await connect(env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.access_token, 'ACCESS');
  assert.equal(data.channel.id, 'UC1');
  assert.ok(!JSON.stringify(data).includes('REFRESH'), 'the refresh token must stay in the cloud');
  const row = rows.get('mem_1|UC1');
  assert.ok(row.refresh_token_enc.startsWith('v1:') && !row.refresh_token_enc.includes('REFRESH'));
  assert.equal(row.channel_title, 'My Channel');
});

test('exchange requires PKCE and refuses a redirect that is not the desktop loopback', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'exchange', { body: { code: 'C', redirect_uri: LOOPBACK } })).status, 400);
  assert.equal((await call(env, 'exchange', { body: { code: 'C', code_verifier: 'V', redirect_uri: 'http://evil.example.com/callback' } })).status, 400);
  assert.equal(googleCalls.length, 0);
});

test('exchange fails clearly when Google returns no refresh token', async () => {
  const env = makeEnv();
  googleReplies['oauth2.googleapis.com/token'] = { access_token: 'A', expires_in: 3600 };
  googleReplies['youtube/v3/channels'] = CHANNEL;
  const res = await call(env, 'exchange', { body: { code: 'C', code_verifier: 'V', redirect_uri: LOOPBACK } });
  assert.equal(res.status, 502);
  assert.equal(rows.size, 0);
});

test('access-token refreshes with the stored refresh token and returns only an access token', async () => {
  const env = makeEnv();
  await connect(env);
  googleReplies['oauth2.googleapis.com/token'] = { access_token: 'FRESH', expires_in: 3599 };
  const res = await call(env, 'access-token');
  const data = await res.json();
  assert.equal(data.access_token, 'FRESH');
  assert.ok(!JSON.stringify(data).includes('REFRESH'));
  const sent = new URLSearchParams(googleCalls[googleCalls.length - 1].init.body);
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('refresh_token'), 'REFRESH');
});

test('access-token → 409 reconnect (and the dead row is removed) when Google says invalid_grant', async () => {
  const env = makeEnv();
  await connect(env);
  googleReplies['oauth2.googleapis.com/token'] = { error: 'invalid_grant', __status: 400 };
  const res = await call(env, 'access-token');
  assert.equal(res.status, 409);
  assert.equal(rows.size, 0);
});

test('access-token with nothing connected → 409', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'access-token')).status, 409);
});

test('me reports not connected, then the connected channel', async () => {
  const env = makeEnv();
  assert.equal((await (await call(env, 'me', { method: 'GET' })).json()).connected, false);
  await connect(env);
  const data = await (await call(env, 'me', { method: 'GET' })).json();
  assert.equal(data.connected, true);
  assert.equal(data.channel.title, 'My Channel');
});

test('disconnect revokes at Google and deletes the row', async () => {
  const env = makeEnv();
  await connect(env);
  const res = await call(env, 'disconnect', { body: { channel_id: 'UC1' } });
  assert.equal(res.status, 200);
  assert.equal(rows.size, 0);
  assert.ok(googleCalls.some((c) => c.url.includes('oauth2.googleapis.com/revoke')));
});
