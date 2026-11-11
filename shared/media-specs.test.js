// Which stored renditions does a clip need, given where it will be posted?
// Run: node --test shared/media-specs.test.js
//
// The rule (founder, 2026-11-12): one clip is stored ONCE and tagged with every platform it will
// be posted to; only a different ASPECT RATIO forces a second stored file. Platforms share a file
// when the clip's aspect falls inside every one of their accepted bands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_SPECS, planRenditions } from './media-specs.js';

const vertical = { width: 1080, height: 1920, durationSec: 60, bytes: 20e6 };
const landscape = { width: 1920, height: 1080, durationSec: 60, bytes: 20e6 };
const square = { width: 1080, height: 1080, durationSec: 60, bytes: 20e6 };
const T = (platform, kind) => ({ platform, kind });
const ids = (plan) => plan.renditions.map((r) => r.id);
const labels = (r) => r.targets.map((t) => `${t.platform}:${t.kind}`).sort();

test('every spec declares a native aspect and an accepted band containing it', () => {
  for (const [p, kinds] of Object.entries(MEDIA_SPECS)) {
    for (const [k, s] of Object.entries(kinds)) {
      assert.ok(s.nativeAspect > 0, `${p}.${k} nativeAspect`);
      assert.ok(s.aspectBand.min <= s.nativeAspect && s.nativeAspect <= s.aspectBand.max, `${p}.${k} band must contain its own native aspect`);
    }
  }
});

test('a vertical clip going to IG reel + TikTok + YouTube Short is stored ONCE', () => {
  const plan = planRenditions({ clip: vertical, targets: [T('ig', 'reel'), T('tt', 'video'), T('yt', 'short')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(ids(plan), ['source']);
  assert.deepEqual(labels(plan.renditions[0]), ['ig:reel', 'tt:video', 'yt:short']);
});

test('a landscape clip goes to IG reel + TikTok + YouTube video as ONE file (Reels and TikTok accept 16:9)', () => {
  const plan = planRenditions({ clip: landscape, targets: [T('ig', 'reel'), T('tt', 'video'), T('yt', 'video')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(ids(plan), ['source']);
  assert.deepEqual(labels(plan.renditions[0]), ['ig:reel', 'tt:video', 'yt:video']);
});

test('a landscape clip going only to IG reel is stored as-is — no derived copy', () => {
  const plan = planRenditions({ clip: landscape, targets: [T('ig', 'reel')] });
  assert.deepEqual(ids(plan), ['source']);
});

test('a landscape clip: a YouTube Short (vertical/square only) is the one that needs a derived vertical file', () => {
  const plan = planRenditions({ clip: landscape, targets: [T('ig', 'reel'), T('yt', 'short')] });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.renditions.length, 2);
  assert.deepEqual(labels(plan.renditions.find((r) => !r.derived)), ['ig:reel']);
  const derived = plan.renditions.find((r) => r.derived);
  assert.deepEqual(labels(derived), ['yt:short']);
  assert.ok(Math.abs(derived.aspect - 9 / 16) < 1e-9);
});

test('an ultra-wide clip (21:9) is outside what Reels accept: IG reel + TikTok share ONE derived file', () => {
  const ultra = { width: 2520, height: 1080, durationSec: 60, bytes: 20e6 };
  const plan = planRenditions({ clip: ultra, targets: [T('ig', 'reel'), T('tt', 'video'), T('yt', 'video')] });
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.renditions.length, 2, 'YouTube video keeps the source; IG + TikTok share one derived file');
  assert.deepEqual(labels(plan.renditions.find((r) => r.derived)), ['ig:reel', 'tt:video']);
});

test('a square clip is accepted by IG reel and YouTube Short as-is', () => {
  const plan = planRenditions({ clip: square, targets: [T('ig', 'reel'), T('yt', 'short')] });
  assert.deepEqual(ids(plan), ['source']);
});

test('assignments map every target to the rendition that serves it', () => {
  const plan = planRenditions({ clip: landscape, targets: [T('ig', 'reel'), T('yt', 'short'), T('yt', 'video')] });
  assert.equal(plan.assignments['ig:reel'], 'source');
  assert.equal(plan.assignments['yt:video'], 'source');
  assert.match(plan.assignments['yt:short'], /^derived-/);
});

test('duplicate targets are collapsed', () => {
  const plan = planRenditions({ clip: vertical, targets: [T('ig', 'reel'), T('ig', 'reel')] });
  assert.equal(plan.renditions[0].targets.length, 1);
});

test('no targets means no renditions', () => {
  assert.deepEqual(planRenditions({ clip: vertical, targets: [] }).renditions, []);
});

test('an unknown platform or kind is a problem that names what IS supported', () => {
  const a = planRenditions({ clip: vertical, targets: [T('myspace', 'reel')] });
  assert.match(a.problems[0], /myspace.*Supported.*ig/s);
  const b = planRenditions({ clip: vertical, targets: [T('ig', 'podcast')] });
  assert.match(b.problems[0], /podcast.*ig.*reel/s);
});

test('a clip over TikTok\'s 10-minute API limit is a problem naming TikTok, not a silent pass', () => {
  const plan = planRenditions({ clip: { ...vertical, durationSec: 601 }, targets: [T('tt', 'video'), T('ig', 'reel')] });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /TikTok.*600/);
});

test('a clip over YouTube Shorts\' 3 minutes is a problem', () => {
  const plan = planRenditions({ clip: { ...vertical, durationSec: 181 }, targets: [T('yt', 'short')] });
  assert.match(plan.problems[0], /180/);
});

test('a clip under TikTok\'s 360px minimum is a problem', () => {
  const plan = planRenditions({ clip: { width: 240, height: 426, durationSec: 10, bytes: 1e6 }, targets: [T('tt', 'video')] });
  assert.match(plan.problems[0], /360/);
});

test('a malformed clip is a problem, never NaN rendition aspects', () => {
  for (const clip of [null, {}, { width: 0, height: 1920 }, { width: 1080, height: -1 }, { width: 'a', height: 2 }]) {
    const plan = planRenditions({ clip, targets: [T('ig', 'reel')] });
    assert.equal(plan.renditions.length, 0);
    assert.match(plan.problems[0], /clip/i);
  }
});
