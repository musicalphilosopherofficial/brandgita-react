// A retry after Instagram has ALREADY published must never publish again.
// Run: node --test cron-worker/publish-recovery.test.js
//
// Why: media_publish returning an id means the post is live. If the permalink lookup then
// fails ("Media ID is not available" while Instagram propagates), the old flow threw, the
// poster retried from scratch, created a NEW container and published a SECOND copy. The media
// id is now persisted the moment it exists, and a retry that finds one only fetches the link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagram } from './platforms/instagram.js';

const noSleep = () => Promise.resolve();
const reelPost = (over = {}) => ({
  id: 'p1', ig_user_id: 'ig1', type: 'reel', caption: 'hi', cover_key: null,
  asset_keys: JSON.stringify(['ig1/reel/a.mp4']), ...over,
});

function mockGraph({ permalinkFailures = 0 } = {}) {
  const calls = [];
  let permalinkTries = 0;
  const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method || 'GET'} ${new URL(u).pathname}`);
    if (u.includes('/media_publish')) return json({ id: 'MEDIA1' });
    if (u.endsWith('/media') || u.includes('/ig1/media')) return json({ id: 'CONTAINER1' });
    if (u.includes('/CONTAINER1')) return json({ status_code: 'FINISHED' });
    if (u.includes('/MEDIA1')) {
      permalinkTries++;
      if (permalinkTries <= permalinkFailures) {
        return json({ error: { message: 'Media ID is not available', code: 24 } }, false);
      }
      return json({ permalink: 'https://instagram.com/reel/X/' });
    }
    throw new Error(`unexpected ${u}`);
  };
  return { calls, tries: () => permalinkTries };
}

const run = (post, deps) =>
  instagram.publish({
    post, assetKeys: JSON.parse(post.asset_keys), creds: { accessToken: 't' },
    deps: { mediaBase: 'https://m.example/media', sleepFn: noSleep, pollIntervalMs: 0, pollMaxMs: 5000, ...deps },
  });

test('the media id is persisted as soon as media_publish returns, before the permalink lookup', async () => {
  const order = [];
  const g = mockGraph();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes('/MEDIA1')) order.push('permalink'); return orig(u, o); };
  await run(reelPost(), { onMediaPublished: async (id) => { order.push(`saved:${id}`); } });
  assert.deepEqual(order, ['saved:MEDIA1', 'permalink']);
  assert.ok(g.calls.some((c) => c.includes('media_publish')));
});

test('a row that already has ig_media_id only fetches the permalink — NO container, NO publish', async () => {
  const g = mockGraph();
  const out = await run(reelPost({ ig_media_id: 'MEDIA1' }), {});
  assert.equal(out.permalink, 'https://instagram.com/reel/X/');
  assert.equal(g.calls.some((c) => c.includes('media_publish')), false, 'must not publish twice');
  assert.equal(g.calls.some((c) => c.endsWith('/ig1/media')), false, 'must not create a new container');
});

test('"Media ID is not available" is retried and then succeeds', async () => {
  const g = mockGraph({ permalinkFailures: 2 });
  const out = await run(reelPost(), { onMediaPublished: async () => {} });
  assert.equal(out.permalink, 'https://instagram.com/reel/X/');
  assert.equal(g.tries(), 3);
});

test('a permalink that never resolves still leaves the media id saved, and throws', async () => {
  mockGraph({ permalinkFailures: 99 });
  let saved = null;
  await assert.rejects(run(reelPost(), { onMediaPublished: async (id) => { saved = id; } }), /not available/i);
  assert.equal(saved, 'MEDIA1');
});
