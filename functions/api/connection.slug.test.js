// The connection check must hand back the CURRENT media_slug so a desktop holding a
// stale one self-heals. Run with: node --test functions/api/connection.slug.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './connection.js';
import { mediaSlug } from './_auth.js';
import { encryptToken } from './_crypto.js';

const OWNER = 'ig-owner-1';
const ENC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

function makeEnv(extra = {}) {
  return {
    TOKEN_ENC_KEY: ENC_KEY,
    API_SECRET: 'the-shared-secret',
    ...extra,
    DB: {
      prepare(sql) {
        return {
          bind: () => ({
            async first() {
              if (sql.includes('desktop_token')) {
                return {
                  ig_user_id: OWNER,
                  desktop_token_created_at: new Date().toISOString(),
                };
              }
              if (sql.includes('access_token')) return { access_token: null };
              return null;
            },
          }),
        };
      },
    },
  };
}

async function call(env) {
  const seeded = await encryptToken('IGAA-live-token', env);
  const withToken = { ...env };
  withToken.DB = {
    prepare(sql) {
      return {
        bind: () => ({
          async first() {
            if (sql.includes('desktop_token')) {
              return {
                ig_user_id: OWNER,
                desktop_token_created_at: new Date().toISOString(),
              };
            }
            if (sql.includes('access_token')) {
              return { access_token: seeded, token_expiry: '2099-01-01T00:00:00Z' };
            }
            return null;
          },
        }),
      };
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const res = await onRequest({
    env: withToken,
    request: {
      method: 'GET',
      headers: { get: (h) => (h === 'Authorization' ? 'Bearer tok' : null) },
    },
  });
  return res.json();
}

test('connection returns the SAME media_slug /api/token would issue', async () => {
  const env = makeEnv();
  const body = await call(env);
  assert.equal(body.ok, true);
  assert.equal(body.media_slug, await mediaSlug(env, OWNER));
});

// The whole point: after a re-key, an install with a cached slug learns the new one from
// the pre-flight it already runs, instead of 403ing every upload until it reconnects.
test('after a re-key the connection check reports the NEW slug', async () => {
  const before = await call(makeEnv());
  const after = await call(makeEnv({ MEDIA_SLUG_SECRET: 'freshly-rotated-key' }));
  assert.notEqual(after.media_slug, before.media_slug, 're-key must change the slug');
  assert.equal(after.media_slug, await mediaSlug(makeEnv({ MEDIA_SLUG_SECRET: 'freshly-rotated-key' }), OWNER));
});

test('the slug never contains the ig_user_id', async () => {
  const body = await call(makeEnv());
  assert.ok(!body.media_slug.includes(OWNER));
  assert.match(body.media_slug, /^[a-z-]+-by-[a-z-]+-[0-9a-f]{20}$/);
});
