// Unit tests — /api/google/token: the Google OAuth exchange, done server-side.
//
// Layer (philosophy/testing-bdd-vs-tdd.md): TDD unit. buildTokenForm is a pure function over
// a request body; the network half is exercised by the live probe recorded below, not mocked.
//
// WHY THIS EXISTS (2026-08-29)
// The desktop app exchanged Google auth codes itself, reading GOOGLE_CLIENT_SECRET from
// electron-shell/.env with `|| ''`. That file is deliberately not packaged, so in a shipped
// build the secret was always empty. The code comment claimed "PKCE carries the packaged
// flow". Measured against Google's live endpoint with a bogus code, which separates a client
// failure from a code failure:
//
//   empty client_secret  → invalid_request  "client_secret is missing."
//   real  client_secret  → invalid_grant    "Malformed auth code."
//
// The second is the client authenticating fine and only the code being wrong. Google requires
// the secret for a Desktop client even with PKCE. The comment was wrong, and the failure
// landed AFTER the creator had picked an account and pressed Allow.

import { test } from 'node:test';
import assert from 'node:assert';

import { buildTokenForm } from './token.js';

const CREDS = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-server-side-only',
  redirectUri: 'http://127.0.0.1:8123',
};

const CODE_BODY = {
  grant_type: 'authorization_code',
  code: 'the-auth-code',
  code_verifier: 'the-verifier',
  redirect_uri: 'http://127.0.0.1:8123',
};

// ── the exchange Google actually accepts ──────────────────────────────────────

test('the client secret is added server-side — the whole reason this endpoint exists', () => {
  const { form } = buildTokenForm(CODE_BODY, CREDS);
  assert.strictEqual(form.get('client_secret'), 'GOCSPX-server-side-only');
  assert.strictEqual(form.get('client_id'), CREDS.clientId);
});

test('the code and its PKCE verifier are forwarded unchanged', () => {
  const { form } = buildTokenForm(CODE_BODY, CREDS);
  assert.strictEqual(form.get('code'), 'the-auth-code');
  assert.strictEqual(form.get('code_verifier'), 'the-verifier');
  assert.strictEqual(form.get('grant_type'), 'authorization_code');
});

test('a refresh sends the refresh token and no code fields', () => {
  const { form } = buildTokenForm({ grant_type: 'refresh_token', refresh_token: 'rt' }, CREDS);
  assert.strictEqual(form.get('refresh_token'), 'rt');
  assert.strictEqual(form.get('code'), null);
  assert.strictEqual(form.get('code_verifier'), null);
});

test('the redirect_uri falls back to the server default when the app omits it', () => {
  const { form } = buildTokenForm({ ...CODE_BODY, redirect_uri: undefined }, CREDS);
  assert.strictEqual(form.get('redirect_uri'), 'http://127.0.0.1:8123');
});

// ── what it refuses ───────────────────────────────────────────────────────────

test('PKCE is mandatory — without it this endpoint is a code-exchange oracle', () => {
  // The load-bearing refusal. The proxy holds the client secret, so anyone who steals an auth
  // code could otherwise post it here and get tokens. The verifier proves the caller is the
  // client that began the flow.
  const { error, form } = buildTokenForm({ ...CODE_BODY, code_verifier: undefined }, CREDS);
  assert.ok(!form);
  assert.match(error, /code_verifier/);
});

test('only the two known grants are forwarded', () => {
  // Not a passthrough to Google's token endpoint. `client_credentials` or a device grant with
  // our secret attached is not something this app ever needs.
  for (const grant of ['client_credentials', 'password', 'urn:ietf:params:oauth:grant-type:device_code', undefined]) {
    const { error, form } = buildTokenForm({ grant_type: grant, code: 'c', code_verifier: 'v' }, CREDS);
    assert.ok(!form, `${grant} was forwarded`);
    assert.match(error, /grant_type/);
  }
});

test('a missing code or refresh token is named, not passed to Google to reject', () => {
  assert.match(buildTokenForm({ grant_type: 'authorization_code', code_verifier: 'v' }, CREDS).error, /code is required/);
  assert.match(buildTokenForm({ grant_type: 'refresh_token' }, CREDS).error, /refresh_token is required/);
});

test('a deploy missing its Google credentials says so, as a 503, not a 400', () => {
  // This is the original bug's shape, and the distinction is the lesson from it: an empty
  // secret is the SERVER being unconfigured. Reported as a client error it reads as "your
  // request was wrong", which is what sent the last one hours in the wrong direction.
  const res = buildTokenForm(CODE_BODY, { ...CREDS, clientSecret: '' });
  assert.strictEqual(res.status, 503);
  assert.match(res.error, /missing Google credentials/);
});

test('the secret is never echoed back in an error', () => {
  const res = buildTokenForm({ grant_type: 'nope' }, CREDS);
  assert.ok(!JSON.stringify(res).includes('GOCSPX-server-side-only'));
});
