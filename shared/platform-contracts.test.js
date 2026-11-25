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

// ── Trial capability (Instagram trial reels) ──────────────────────────────────
import { resolveTrialStrategy } from './platform-contracts.js';

test('every registered platform declares a `trial` key (null when unsupported)', () => {
  for (const [id, c] of Object.entries(CONTRACTS)) {
    assert.ok('trial' in c, `${id} must declare trial (an object, or null)`);
  }
});

test('Instagram declares reel-only trials, and NO default: a trial happens only when asked for', () => {
  assert.deepEqual(
    { kinds: [...ig().trial.kinds], strategies: [...ig().trial.strategies] },
    { kinds: ['reel'], strategies: ['MANUAL', 'SS_PERFORMANCE'] },
  );
  // 2026-11-12: a hardcoded default made every reel a trial and Instagram rejected the account's
  // posts with (#10). Opting in is the caller's explicit act, never the platform's assumption.
  assert.equal('default' in ig().trial, false);
});

test('resolve: an eligible reel with no value is a NORMAL reel, not a trial', () => {
  assert.deepEqual(resolveTrialStrategy(ig(), { type: 'reel' }), { strategy: null, problems: [] });
  assert.deepEqual(resolveTrialStrategy(ig(), { type: 'reel', requested: null }), { strategy: null, problems: [] });
});

test('resolve: an explicit MANUAL on a reel is kept', () => {
  assert.deepEqual(resolveTrialStrategy(ig(), { type: 'reel', requested: 'MANUAL' }), { strategy: 'MANUAL', problems: [] });
});

test('resolve: a carousel with no value is simply not a trial', () => {
  assert.deepEqual(resolveTrialStrategy(ig(), { type: 'carousel' }), { strategy: null, problems: [] });
});

test('resolve: a trial requested on a carousel is rejected, naming the eligible kinds', () => {
  const r = resolveTrialStrategy(ig(), { type: 'carousel', requested: 'MANUAL' });
  assert.equal(r.strategy, null);
  assert.match(r.problems[0], /trial.*reel/i);
});

test('resolve: an unknown strategy is rejected, naming what is allowed', () => {
  const r = resolveTrialStrategy(ig(), { type: 'reel', requested: 'AUTO' });
  assert.match(r.problems[0], /MANUAL/);
  assert.match(r.problems[0], /SS_PERFORMANCE/);
  assert.match(r.problems[0], /AUTO/);
});

test('resolve: a non-string strategy is rejected, not coerced', () => {
  assert.equal(resolveTrialStrategy(ig(), { type: 'reel', requested: 5 }).problems.length, 1);
  assert.equal(resolveTrialStrategy(ig(), { type: 'reel', requested: {} }).problems.length, 1);
});

test('resolve: a platform with trial:null rejects a requested trial and defaults to none', () => {
  const noTrial = { id: 'zz', label: 'Zed', trial: null };
  assert.deepEqual(resolveTrialStrategy(noTrial, { type: 'reel' }), { strategy: null, problems: [] });
  const r = resolveTrialStrategy(noTrial, { type: 'reel', requested: 'MANUAL' });
  assert.match(r.problems[0], /Zed.*trial/i);
});

// ── Story: a content type, declared per platform as data (not an Instagram special case) ──────────────
import { assetKindOf } from './platform-contracts.js';

test('assetKindOf: .jpg/.jpeg is an image, .mp4 a video, anything else null (Meta stories take JPEG only)', () => {
  assert.equal(assetKindOf('u/a.jpg'), 'image');
  assert.equal(assetKindOf('u/a.JPEG'), 'image');
  assert.equal(assetKindOf('u/a.mp4'), 'video');
  assert.equal(assetKindOf('u/a.png'), null);
  assert.equal(assetKindOf('u/a'), null);
});

test('Instagram declares story among its content types; reel and carousel are unchanged', () => {
  assert.deepEqual([...ig().contentTypes].sort(), ['carousel', 'reel', 'story']);
});

test('a story is exactly one .jpg or .mp4, with an empty caption and no cover', () => {
  assert.deepEqual(ig().validateCreate({ type: 'story', asset_keys: ['u/a.jpg'], caption: '' }), []);
  assert.deepEqual(ig().validateCreate({ type: 'story', asset_keys: ['u/a.mp4'], caption: '' }), []);
  assert.match(ig().validateCreate({ type: 'story', asset_keys: ['u/a.jpg', 'u/b.jpg'], caption: '' })[0], /story needs exactly 1 asset/);
  assert.match(ig().validateCreate({ type: 'story', asset_keys: [], caption: '' })[0], /story needs exactly 1 asset/);
});

test('a story with a caption is REJECTED explicitly, never silently dropped', () => {
  const p = ig().validateCreate({ type: 'story', asset_keys: ['u/a.jpg'], caption: 'hello' });
  assert.equal(p.length, 1);
  assert.match(p[0], /story cannot have a caption/);
});

test('a story with a cover_key is rejected', () => {
  const p = ig().validateCreate({ type: 'story', asset_keys: ['u/a.jpg'], caption: '', cover_key: 'u/c.jpg' });
  assert.match(p.join(';'), /story cannot have a cover/);
});

test('a story asset that is not .jpg/.mp4 (a PNG) is rejected, naming the key', () => {
  const p = ig().validateCreate({ type: 'story', asset_keys: ['u/a.png'], caption: '' });
  assert.match(p.join(';'), /\.jpg.*\.mp4|JPEG/);
  assert.match(p.join(';'), /a\.png/);
});

test('reel and carousel keep their exact messages and still accept any caption/cover handling as before', () => {
  assert.match(ig().validateCreate({ type: 'reel', asset_keys: ['a', 'b'], caption: '' })[0], /a reel needs exactly 1 asset/);
  assert.match(ig().validateCreate({ type: 'carousel', asset_keys: ['a'], caption: '' })[0], /a carousel needs between 2 and 10 assets/);
  assert.deepEqual(ig().validateCreate({ type: 'reel', asset_keys: ['a'], caption: 'hi', cover_key: 'c' }), []);
});

test('every platform declares its content types as a shapes table, and contentTypes is derived from it (platform-agnostic)', () => {
  for (const id of supportedPlatforms()) {
    const c = contractFor(id);
    assert.deepEqual([...c.contentTypes].sort(), Object.keys(c.shapes).sort(), id);
  }
});

test('captionRequired: reel/carousel yes, story no, TikTok no', () => {
  assert.equal(contractFor('ig').captionRequired('reel'), true);
  assert.equal(contractFor('ig').captionRequired('carousel'), true);
  assert.equal(contractFor('ig').captionRequired('story'), false);
  assert.equal(contractFor('tt').captionRequired('reel'), false);
});
