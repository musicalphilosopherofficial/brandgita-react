// Tests for POST /api/whop/webhook — run with:
//   node --test functions/api/whop/webhook.test.js
//
// Signs test payloads with a REAL HMAC, using the same Standard Webhooks algorithm the
// endpoint verifies against — so these tests prove the signing/verification MATCH each
// other, not just that verifySignature() agrees with itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { onRequest } from './webhook.js';

const SECRET_RAW = Buffer.from('a'.repeat(32)); // 32 raw bytes
const SECRET = 'whsec_' + SECRET_RAW.toString('base64');

function sign(id, timestamp, body) {
  const mac = createHmac('sha256', SECRET_RAW).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function makeEnv(dbRows = { runs: [] }) {
  return {
    WHOP_WEBHOOK_SECRET: SECRET,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                dbRows.runs.push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
    _rows: dbRows,
  };
}

function membershipPayload(type, overrides = {}) {
  return JSON.stringify({
    id: 'msg_1',
    type,
    api_version: 'v1',
    timestamp: new Date().toISOString(),
    account_id: 'biz_1',
    data: {
      id: 'mem_123',
      status: type === 'membership.activated' ? 'active' : 'inactive',
      user: { id: 'user_456', email: 'creator@example.com' },
      plan: { id: 'plan_789' },
      product: { id: 'prod_1' },
      ...overrides,
    },
  });
}

function req(body, { id = 'whmsg_1', ts = Math.floor(Date.now() / 1000).toString(), sig } = {}) {
  const signature = sig ?? sign(id, ts, body);
  const headers = new Map([
    ['webhook-id', id],
    ['webhook-timestamp', ts],
    ['webhook-signature', signature],
  ]);
  return {
    method: 'POST',
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  };
}

test('a correctly signed membership.activated is accepted and upserts', async () => {
  const env = makeEnv();
  const body = membershipPayload('membership.activated');
  const res = await onRequest({ request: req(body), env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(env._rows.runs.length, 1);
  assert.deepEqual(env._rows.runs[0].args.slice(0, 4), ['mem_123', 'user_456', 'creator@example.com', 'active']);
});

test('membership.deactivated stores status=inactive', async () => {
  const env = makeEnv();
  const body = membershipPayload('membership.deactivated');
  await onRequest({ request: req(body), env });
  assert.equal(env._rows.runs[0].args[3], 'inactive');
});

test('a TAMPERED body is rejected even with a syntactically valid signature header', async () => {
  const env = makeEnv();
  const original = membershipPayload('membership.activated');
  const signature = sign('whmsg_1', Math.floor(Date.now() / 1000).toString(), original);
  const tampered = original.replace('user_456', 'user_ATTACKER');
  const res = await onRequest({
    request: req(tampered, { sig: signature }),
    env,
  });
  assert.equal(res.status, 401);
  assert.equal(env._rows.runs.length, 0, 'must not store an unverified event');
});

test('wrong secret is rejected', async () => {
  const env = makeEnv();
  env.WHOP_WEBHOOK_SECRET = 'whsec_' + Buffer.from('b'.repeat(32)).toString('base64');
  const body = membershipPayload('membership.activated');
  const res = await onRequest({ request: req(body), env }); // signed with SECRET, not env's
  assert.equal(res.status, 401);
});

test('a timestamp older than 5 minutes is rejected (replay protection)', async () => {
  const env = makeEnv();
  const body = membershipPayload('membership.activated');
  const staleTs = (Math.floor(Date.now() / 1000) - 600).toString();
  const res = await onRequest({ request: req(body, { ts: staleTs, sig: sign('whmsg_1', staleTs, body) }), env });
  assert.equal(res.status, 401);
});

test('missing signature headers are rejected, not treated as unsigned-but-ok', async () => {
  const env = makeEnv();
  const body = membershipPayload('membership.activated');
  const res = await onRequest({
    request: { method: 'POST', headers: { get: () => null }, text: async () => body },
    env,
  });
  assert.equal(res.status, 401);
});

test('missing WHOP_WEBHOOK_SECRET fails closed, not open', async () => {
  const env = makeEnv();
  delete env.WHOP_WEBHOOK_SECRET;
  const body = membershipPayload('membership.activated');
  const res = await onRequest({ request: req(body), env });
  assert.equal(res.status, 503);
  assert.equal(env._rows.runs.length, 0);
});

test('an unrecognised event type is acknowledged (2xx) so Whop does not retry it', async () => {
  const env = makeEnv();
  const body = JSON.stringify({ id: 'msg_2', type: 'membership.trial_ending_soon', data: {} });
  const res = await onRequest({ request: req(body), env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'membership.trial_ending_soon');
  assert.equal(env._rows.runs.length, 0);
});

test('a membership event missing user.id is rejected rather than stored with a null identity', async () => {
  const env = makeEnv();
  const body = JSON.stringify({
    id: 'msg_3',
    type: 'membership.activated',
    data: { id: 'mem_999', user: {} },
  });
  const res = await onRequest({ request: req(body), env });
  assert.equal(res.status, 400);
  assert.equal(env._rows.runs.length, 0);
});

test('GET is rejected', async () => {
  const res = await onRequest({ request: { method: 'GET' }, env: makeEnv() });
  assert.equal(res.status, 405);
});

test('a D1 failure returns 500 so Whop retries, rather than swallowing it as {ok:false}', async () => {
  const env = makeEnv();
  env.DB.prepare = () => ({ bind: () => ({ async run() { throw new Error('D1 down'); } }) });
  const body = membershipPayload('membership.activated');
  const res = await onRequest({ request: req(body), env });
  assert.equal(res.status, 500);
});

test('key rotation: multiple space-separated v1 signatures, any match accepted', async () => {
  const env = makeEnv();
  const body = membershipPayload('membership.activated');
  const id = 'whmsg_2';
  const ts = Math.floor(Date.now() / 1000).toString();
  const real = sign(id, ts, body);
  const decoy = 'v1,not-a-real-signature==';
  const res = await onRequest({ request: req(body, { id, ts, sig: `${decoy} ${real}` }), env });
  assert.equal(res.status, 200);
});
