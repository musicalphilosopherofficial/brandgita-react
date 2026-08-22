// Tests for checkWhopLicense — run with: node --test functions/api/_whop.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWhopLicense } from './_whop.js';

function mockFetch(status, body) {
  return async () => new Response(JSON.stringify(body), { status });
}

test('an active membership is accepted and its identity extracted', async () => {
  globalThis.fetch = mockFetch(200, {
    id: 'mem_abc', status: 'active', valid: true, user: 'user_1', email: 'a@b.com',
  });
  const r = await checkWhopLicense('lic_valid', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(r, { ok: true, membershipId: 'mem_abc', whopUserId: 'user_1', email: 'a@b.com' });
});

test('a 404 from Whop -> 402 "not found", not a raw pass-through', async () => {
  globalThis.fetch = mockFetch(404, { error: { message: 'No such Membership found' } });
  const r = await checkWhopLicense('lic_bad', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

test('a cancelled membership (valid:false) is rejected even though Whop found it', async () => {
  globalThis.fetch = mockFetch(200, { id: 'mem_x', status: 'canceled', valid: false, user: 'u' });
  const r = await checkWhopLicense('lic_cancelled', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 402);
});

test('REGRESSION: status="completed" + valid:true is ACCEPTED — a real trial membership on '
  + 'this account returns exactly this shape, and gating on status alone would reject it', async () => {
  // Pinned to a real API response captured 2026-08-22 (membership mem_oBHeJeRZNqmKUl),
  // not a guess — status vocabulary varies by plan/payment type and is not the signal.
  globalThis.fetch = mockFetch(200, {
    id: 'mem_oBHeJeRZNqmKUl', status: 'completed', valid: true,
    user: 'user_mvI3tlVgBiCNU', email: 'utsavother16@gmail.com',
  });
  const r = await checkWhopLicense('B-1D6B09-5C997A94-F155F5W', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, true);
  assert.equal(r.membershipId, 'mem_oBHeJeRZNqmKUl');
});

test('missing license_key is rejected before any network call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  const r = await checkWhopLicense('', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('missing WHOP_COMPANY_API fails closed with 503, never treated as "valid"', async () => {
  const r = await checkWhopLicense('lic_x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('a network failure fails CLOSED — unreachable Whop must not grant access', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r = await checkWhopLicense('lic_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('a malformed 200 (no user field at all) is rejected rather than trusted', async () => {
  globalThis.fetch = mockFetch(200, { id: 'mem_x', status: 'active', valid: true });
  const r = await checkWhopLicense('lic_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('the license key is URL-encoded into the request path', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ id: 'm', status: 'active', valid: true, user: 'u' }), { status: 200 });
  };
  await checkWhopLicense('lic/with spaces', { WHOP_COMPANY_API: 'k' });
  assert.ok(!capturedUrl.includes('lic/with spaces'));
  assert.ok(capturedUrl.includes(encodeURIComponent('lic/with spaces')));
});

// ── validateDevice ────────────────────────────────────────────────────────────

import { validateDevice } from './_whop.js';

test('201 from Whop means the device is valid (first use or matching)', async () => {
  globalThis.fetch = mockFetch(201, {});
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(r, { ok: true });
});

test('400 means the licence is bound to a DIFFERENT device', async () => {
  globalThis.fetch = mockFetch(400, {});
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test('401 (missing member:manage) fails closed with 502, never treated as valid', async () => {
  globalThis.fetch = mockFetch(401, {});
  const r = await validateDevice('mem_x', 'hash123', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('missing device_hash is rejected before any network call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 201 }); };
  const r = await validateDevice('mem_x', '', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('missing WHOP_COMPANY_API fails closed with 503', async () => {
  const r = await validateDevice('mem_x', 'hash', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('sends the metadata under Whop\'s own `hwid` key, not an invented one', async () => {
  // This is not a style preference — an earlier version used `device_hash`, and every
  // call against a REAL, already-bound membership came back as a mismatch even for the
  // identical value, because Whop compares the whole metadata object and the key
  // differed from whatever was already stored. Confirmed live 2026-08-22.
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return new Response('{}', { status: 201 });
  };
  await validateDevice('mem_x', 'the-hash', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(capturedBody, { metadata: { hwid: 'the-hash' } });
});

test('a network failure fails closed', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  const r = await validateDevice('mem_x', 'hash', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

// ── resetDeviceLock ───────────────────────────────────────────────────────────

import { resetDeviceLock } from './_whop.js';

test('a successful reset returns ok', async () => {
  globalThis.fetch = mockFetch(200, { id: 'mem_x', metadata: {} });
  const r = await resetDeviceLock('mem_x', { WHOP_COMPANY_API: 'k' });
  assert.deepEqual(r, { ok: true });
});

test('sends PATCH with empty metadata, not POST validate_license', async () => {
  let capturedMethod, capturedBody, capturedUrl;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedMethod = opts.method;
    capturedBody = JSON.parse(opts.body);
    return new Response('{}', { status: 200 });
  };
  await resetDeviceLock('mem_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(capturedMethod, 'PATCH');
  assert.deepEqual(capturedBody, { metadata: {} });
  assert.ok(!String(capturedUrl).includes('validate_license'));
});

test('a non-OK response fails, not silently treated as reset', async () => {
  globalThis.fetch = mockFetch(404, {});
  const r = await resetDeviceLock('mem_doesnotexist', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

test('missing WHOP_COMPANY_API fails closed', async () => {
  const r = await resetDeviceLock('mem_x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('a network failure fails closed', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  const r = await resetDeviceLock('mem_x', { WHOP_COMPANY_API: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});
