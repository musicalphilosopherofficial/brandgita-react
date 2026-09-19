// Tests for GET /api/connection — run with:
//   node --test functions/api/connection.test.js
// No deps: Node's built-in test runner. Uses the REAL _crypto (a fake-encrypted
// token round-trips through decryptToken) + a mocked global fetch for Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './connection.js';
import { encryptToken } from './_crypto.js';

const OWNER = 'ig-owner-1';
const ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='; // base64 of 32 bytes
const ENV_BASE = { TOKEN_ENC_KEY: ENC_KEY };

// Fake D1: auth's ig_tokens lookup resolves to OWNER; the connection SELECT returns
// whatever `row` we seed; the entitlement JOIN returns `membershipStatus` — undefined
// simulates an ig_tokens row with no whop_membership_id (or no ig_tokens row at all), a
// string simulates a real joined whop_memberships.status.
function makeEnv({ row = undefined, membershipStatus = undefined, entitlementThrows = false } = {}) {
  return {
    ...ENV_BASE,
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('whop_memberships')) {
                  // getEntitlement's LEFT JOIN
                  if (entitlementThrows) throw new Error('simulated D1 failure');
                  return { membership_status: membershipStatus ?? null };
                }
                if (sql.includes('desktop_token')) {
                  // requireUserAuth lookup
                  return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
                }
                if (sql.includes('access_token')) {
                  return row; // may be null/undefined
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}

function ctx(env, { auth = 'Bearer tok', method = 'GET' } = {}) {
  return {
    env,
    request: {
      method,
      headers: { get: (k) => (k === 'Authorization' ? auth : null) },
    },
  };
}

// Meta content_publishing_limit responder.
function mockFetch(resp) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('content_publishing_limit'), 'probes content_publishing_limit');
    return { ok: resp.ok ?? true, json: async () => resp.body };
  };
}

async function encRow(over = {}) {
  return {
    access_token: await encryptToken('live-ig-token', ENV_BASE),
    token_expiry: '2026-12-01T00:00:00.000Z',
    ...over,
  };
}

test('valid publish-capable token → publishable:true with quota', async () => {
  mockFetch({ ok: true, body: { data: [{ quota_usage: 3, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow(), membershipStatus: 'active' });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.connected, true);
  assert.equal(data.publishable, true);
  assert.equal(data.quota_usage, 3);
  assert.equal(data.quota_total, 50);
  assert.equal(data.expires_at, '2026-12-01T00:00:00.000Z');
  assert.equal(data.entitled, true);
});

test('no token stored → connected:false, not_connected', async () => {
  globalThis.fetch = async () => { throw new Error('should not call Meta'); };
  const env = makeEnv({ row: null });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.connected, false);
  assert.equal(data.publishable, false);
  assert.equal(data.reason, 'not_connected');
});

test('expired/invalid token (Meta code 190) → publishable:false, token_invalid', async () => {
  mockFetch({ ok: false, body: { error: { code: 190, message: 'invalid' } } });
  const env = makeEnv({ row: await encRow() });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.connected, true);
  assert.equal(data.publishable, false);
  assert.equal(data.reason, 'token_invalid');
  assert.equal(data.expires_at, '2026-12-01T00:00:00.000Z');
});

test('missing publish permission → publishable:false, permission', async () => {
  mockFetch({ ok: false, body: { error: { code: 10, message: 'permission' } } });
  const env = makeEnv({ row: await encRow() });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.publishable, false);
  assert.equal(data.reason, 'permission');
});

test('Meta unreachable → publishable:null, check_failed (do not tell creator to reconnect)', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const env = makeEnv({ row: await encRow() });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.connected, true);
  assert.equal(data.publishable, null);
  assert.equal(data.reason, 'check_failed');
});

test('missing bearer token → 401', async () => {
  const env = makeEnv({ row: await encRow() });
  const res = await onRequest(ctx(env, { auth: '' }));
  assert.equal(res.status, 401);
});

test('non-GET → 405', async () => {
  const env = makeEnv({ row: await encRow() });
  const res = await onRequest(ctx(env, { method: 'POST' }));
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// Entitlement verdict — a field on the response the client already polls, never a gate
// on the endpoint itself. Present regardless of publishable/connected so the desktop can
// tell "lapsed" apart from "network down" or "device moved".
// ---------------------------------------------------------------------------

test('an active Whop membership is entitled', async () => {
  mockFetch({ ok: true, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow(), membershipStatus: 'active' });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.entitled, true);
  assert.equal(data.entitlement_reason, 'active');
  assert.equal(data.entitlement_message, undefined, 'no message needed when entitled');
});

test('an inactive Whop membership (after membership.deactivated) is not entitled', async () => {
  mockFetch({ ok: true, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow(), membershipStatus: 'inactive' });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200, 'not-entitled is still a 200 — never a 402 on this endpoint');
  assert.equal(data.entitled, false);
  assert.equal(data.entitlement_reason, 'membership_lapsed');
  assert.equal(typeof data.entitlement_message, 'string');
  assert.ok(data.entitlement_message.length > 0);
});

test('not entitled is independent of publishable — a lapsed member with a live token still gets entitled:false', async () => {
  // The token itself may still work (Meta doesn't know the creator stopped paying us), but
  // the client must be told the subscription lapsed regardless of whether IG would accept
  // a publish right now.
  mockFetch({ ok: true, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow(), membershipStatus: 'inactive' });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.publishable, true);
  assert.equal(data.entitled, false);
});

test('a connection with no linked Whop membership fails open (entitled:true, unlinked)', async () => {
  // ig_tokens row exists (whop_membership_id is null on it — a legacy connection, or one
  // made before Whop billing existed). Nothing to check entitlement against, so this must
  // not brick a creator over a column their row never had.
  mockFetch({ ok: true, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow() }); // membershipStatus left undefined
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.entitled, true);
  assert.equal(data.entitlement_reason, 'unlinked');
});

test('no ig_tokens row at all still reports an entitlement verdict alongside not_connected', async () => {
  globalThis.fetch = async () => { throw new Error('should not call Meta'); };
  const env = makeEnv({ row: null });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.connected, false);
  assert.equal(data.reason, 'not_connected');
  assert.equal(data.entitled, true);
  assert.equal(data.entitlement_reason, 'unlinked');
});

test('a D1 failure on the entitlement lookup fails open rather than 500ing the whole check', async () => {
  mockFetch({ ok: true, body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } });
  const env = makeEnv({ row: await encRow(), entitlementThrows: true });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.entitled, true);
  assert.equal(data.entitlement_reason, 'check_failed');
});

test('entitlement verdict is present even when the token is invalid (token_invalid)', async () => {
  mockFetch({ ok: false, body: { error: { code: 190, message: 'invalid' } } });
  const env = makeEnv({ row: await encRow(), membershipStatus: 'inactive' });
  const res = await onRequest(ctx(env));
  const data = await res.json();

  assert.equal(data.reason, 'token_invalid');
  assert.equal(data.entitled, false);
  assert.equal(data.entitlement_reason, 'membership_lapsed');
});
