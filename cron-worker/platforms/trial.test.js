// Instagram trial reels: the container request carries trial_params only for a reel with a strategy.
// Run: node --test cron-worker/platforms/trial.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagram } from './instagram.js';
import { ADAPTERS } from './index.js';
import { CONTRACTS } from '../../shared/platform-contracts.js';

const noSleep = () => Promise.resolve();

function mockGraph() {
  const containerBodies = [];
  const json = (d) => ({ ok: true, status: 200, json: async () => d });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST' && u.endsWith('/media')) {
      containerBodies.push(new URLSearchParams(opts.body));
      return json({ id: 'C1' });
    }
    if (u.includes('/media_publish')) return json({ id: 'M1' });
    if (u.includes('/C1')) return json({ status_code: 'FINISHED' });
    if (u.includes('/M1')) return json({ permalink: 'https://instagram.com/reel/X/' });
    throw new Error(`unexpected ${u}`);
  };
  return containerBodies;
}

const deps = { mediaBase: 'https://m.example/media', sleepFn: noSleep, pollIntervalMs: 0, pollMaxMs: 5000 };
const run = (post, keys) =>
  instagram.publish({ post, assetKeys: keys, creds: { accessToken: 't' }, deps });
const reel = (over = {}) => ({ id: 'p', ig_user_id: 'ig1', type: 'reel', caption: 'c', cover_key: null, ...over });

test('a reel with SS_PERFORMANCE sends trial_params as JSON with that graduation_strategy', async () => {
  const bodies = mockGraph();
  await run(reel({ trial_strategy: 'SS_PERFORMANCE' }), ['ig1/a.mp4']);
  assert.equal(bodies.length, 1);
  assert.deepEqual(JSON.parse(bodies[0].get('trial_params')), { graduation_strategy: 'SS_PERFORMANCE' });
  assert.equal(bodies[0].get('media_type'), 'REELS');
});

test('a reel with MANUAL sends MANUAL', async () => {
  const bodies = mockGraph();
  await run(reel({ trial_strategy: 'MANUAL' }), ['ig1/a.mp4']);
  assert.deepEqual(JSON.parse(bodies[0].get('trial_params')), { graduation_strategy: 'MANUAL' });
});

test('a reel with NO strategy (legacy row) sends no trial_params', async () => {
  const bodies = mockGraph();
  await run(reel({ trial_strategy: null }), ['ig1/a.mp4']);
  assert.equal(bodies[0].has('trial_params'), false);
});

test('a carousel never sends trial_params, even if its row somehow carries a strategy', async () => {
  const bodies = mockGraph();
  await run({ ...reel({ type: 'carousel', trial_strategy: 'MANUAL' }) }, ['ig1/a.jpg', 'ig1/b.jpg']);
  assert.ok(bodies.length >= 3, 'children + parent containers');
  for (const b of bodies) assert.equal(b.has('trial_params'), false);
});

test('an already-published reel is still never republished, trial or not', async () => {
  const bodies = mockGraph();
  const out = await run(reel({ trial_strategy: 'MANUAL', ig_media_id: 'M1' }), ['ig1/a.mp4']);
  assert.equal(bodies.length, 0, 'no container created');
  assert.equal(out.permalink, 'https://instagram.com/reel/X/');
});

test('every adapter in ADAPTERS has a contract that declares `trial`', () => {
  for (const id of Object.keys(ADAPTERS)) {
    assert.ok(CONTRACTS[id], `${id} has no contract`);
    assert.ok('trial' in CONTRACTS[id], `${id} contract must declare trial (object or null)`);
  }
});
