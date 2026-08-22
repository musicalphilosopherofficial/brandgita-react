// Platform contracts — the shared validation vocabulary.
// Run: node --test shared/platform-contracts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTS, DEFAULT_PLATFORM, contractFor, supportedPlatforms } from './platform-contracts.js';

test('the default platform is registered', () => {
  assert.ok(CONTRACTS[DEFAULT_PLATFORM], 'the default must resolve or every legacy client breaks');
});

test('an unknown platform throws naming what IS supported', () => {
  assert.throws(() => contractFor('myspace'), /myspace.*Supported.*ig/s);
});

test('supportedPlatforms is sorted and complete', () => {
  assert.deepEqual(supportedPlatforms(), Object.keys(CONTRACTS).sort());
});

// ── Instagram's content rules ─────────────────────────────────────────────────

const ig = () => contractFor('ig');

test('a valid reel has no problems', () => {
  assert.deepEqual(ig().validateCreate({ type: 'reel', asset_keys: ['a'], caption: 'hi' }), []);
});

test('a valid carousel has no problems', () => {
  assert.deepEqual(ig().validateCreate({ type: 'carousel', asset_keys: ['a', 'b'], caption: 'hi' }), []);
});

test('an unknown type stops early rather than cascading', () => {
  // Reporting "a reel needs exactly 1 asset" for type "podcast" is noise that sends the
  // reader chasing the wrong field.
  const problems = ig().validateCreate({ type: 'podcast', asset_keys: [], caption: '' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /type must be one of/);
});

test('a reel with the wrong asset count is rejected', () => {
  assert.match(ig().validateCreate({ type: 'reel', asset_keys: ['a', 'b'], caption: '' })[0], /exactly 1/);
});

test('a carousel below 2 or above 10 assets is rejected', () => {
  assert.match(ig().validateCreate({ type: 'carousel', asset_keys: ['a'], caption: '' })[0], /between 2 and 10/);
  const eleven = Array.from({ length: 11 }, (_, i) => `k${i}`);
  assert.match(ig().validateCreate({ type: 'carousel', asset_keys: eleven, caption: '' })[0], /between 2 and 10/);
});

test('the caption cap is INSTAGRAM\'s 2200, and lives on the contract not the handler', () => {
  // The cap being per-platform is the whole point: YouTube's description limit is 5000,
  // so enforcing 2200 generically would be silently wrong for platform two.
  assert.equal(ig().captionMax, 2200);
  const long = 'x'.repeat(2201);
  assert.match(ig().validateCreate({ type: 'reel', asset_keys: ['a'], caption: long })[0], /2200/);
});

test('every problem is reported at once, not one per request', () => {
  const long = 'x'.repeat(2201);
  const problems = ig().validateCreate({ type: 'reel', asset_keys: ['a', 'b'], caption: long });
  assert.equal(problems.length, 2, 'both the asset count AND the caption length');
});

test('contracts are frozen — a caller cannot mutate the shared vocabulary', () => {
  // Both deployments import this module. A mutation in one request would leak into every
  // subsequent one on the same isolate.
  assert.throws(() => { CONTRACTS.ig.captionMax = 99; }, TypeError);
});
