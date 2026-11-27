// collaborators at publish time. Run: node --test cron-worker/collaborators.publish.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagram } from './platforms/instagram.js';

const deps = { mediaBase: 'https://m.example', sleepFn: async () => {}, pollIntervalMs: 0, pollMaxMs: 1000 };
const post = (over = {}) => ({ id: 'p', ig_user_id: 'u1', type: 'reel', caption: 'c', collaborators: JSON.stringify(['geoff', 'sam']), ...over });
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const err = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

// calls = every POST as {path, params}. `onCreate` may return a response for a container POST.
function graph({ onCreate } = {}) {
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(init.body));
      calls.push({ path: u.pathname.split('/').pop(), params });
      if (u.pathname.endsWith('/media_publish')) return ok({ id: 'media1' });
      return onCreate?.(params) ?? ok({ id: `c${++n}` });
    }
    return ok({ status_code: 'FINISHED', permalink: 'https://ig/p' });
  };
  return calls;
}
const publish = (p, keys = ['u/reel/a.mp4']) => instagram.publish({ post: p, assetKeys: keys, creds: { accessToken: 't' }, deps });
const published = (calls) => calls.filter((c) => c.path === 'media_publish').length;

test('reel: collaborators go on the container as a JSON array', async () => {
  const calls = graph();
  await publish(post());
  assert.deepEqual(JSON.parse(calls[0].params.collaborators), ['geoff', 'sam']);
  assert.equal(published(calls), 1);
});
test('carousel: on the PARENT only, never on a child', async () => {
  const calls = graph();
  await publish(post({ type: 'carousel' }), ['u/carousel/a.jpg', 'u/carousel/b.mp4']);
  const containers = calls.filter((c) => c.path === 'media');
  const parent = containers.find((c) => c.params.media_type === 'CAROUSEL');
  assert.deepEqual(JSON.parse(parent.params.collaborators), ['geoff', 'sam']);
  for (const child of containers.filter((c) => c !== parent)) assert.equal(child.params.collaborators, undefined);
});
test('no collaborators: the param is absent', async () => {
  const calls = graph();
  await publish(post({ collaborators: null }));
  assert.equal('collaborators' in calls[0].params, false);
});
for (const [name, error] of [
  ['invalid parameter (code 100)', { code: 100, message: 'Invalid parameter' }],
  ['a message about collaborators', { code: 36000, message: 'Collaborator is not eligible' }],
]) {
  test(`refusal — ${name}: permanent, plain-language, names them, quotes Instagram, publishes nothing`, async () => {
    const calls = graph({ onCreate: () => err(400, error) });
    await assert.rejects(publish(post()), (e) => {
      assert.equal(e.permanent, true);
      assert.match(e.message, /Instagram would not accept/);
      assert.match(e.message, /@geoff, @sam/);
      assert.match(e.message, /Nothing was posted/);
      assert.ok(e.message.includes(error.message));
      return true;
    });
    assert.equal(published(calls), 0);
    assert.equal(calls.length, 1, 'no second attempt without collaborators');
  });
}
for (const [name, status, error] of [
  ['rate limit', 400, { code: 4, message: 'Application request limit reached' }],
  ['Meta marks it transient', 400, { code: 100, message: 'try later', is_transient: true }],
  ['server error', 500, { code: 2, message: 'Service temporarily unavailable' }],
  ['media download fault', 400, { code: 9004, message: 'Media download has failed' }],
]) {
  test(`temporary — ${name}: NOT permanent (retried with collaborators)`, async () => {
    graph({ onCreate: () => err(status, error) });
    await assert.rejects(publish(post()), (e) => { assert.notEqual(e.permanent, true); return true; });
  });
}
test('a dead token is still an auth failure, not a collaborator refusal', async () => {
  graph({ onCreate: () => err(400, { code: 190, message: 'Token expired' }) });
  await assert.rejects(publish(post()), (e) => instagram.isAuthExpired(e) && e.permanent !== true);
});
test('unreadable stored collaborators FAILS the post: never published without them', async () => {
  const calls = graph();
  await assert.rejects(publish(post({ collaborators: '{bad' })), (e) => e.permanent === true);
  assert.equal(calls.length, 0);
});
test('a post without collaborators keeps its old error behaviour on code 100 (retryable, unchanged)', async () => {
  graph({ onCreate: () => err(400, { code: 100, message: 'Invalid parameter' }) });
  await assert.rejects(publish(post({ collaborators: null })), (e) => e.permanent !== true && e.message === 'Invalid parameter');
});
