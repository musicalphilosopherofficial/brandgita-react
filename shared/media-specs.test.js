// Which of the creator's files serves each platform, and which files are stored at all?
// Run: node --test shared/media-specs.test.js
//
// The rule (founder, 2026-11-12): a file is stored ONCE and used by every platform it fits; a second
// file exists only when the creator supplied a different aspect ratio. The creator supplies the
// per-aspect files — nothing here (or anywhere) re-renders video.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_SPECS, assignFiles } from './media-specs.js';

const file = (id, width, height, over = {}) => ({ id, width, height, durationSec: 60, bytes: 20e6, ...over });
const vertical = file('v', 1080, 1920);
const landscape = file('l', 1920, 1080);
const square = file('s', 1080, 1080);
const T = (platform, kind) => ({ platform, kind });
const stored = (plan) => plan.stored.map((f) => f.id);
const usedBy = (plan, id) => plan.stored.find((f) => f.id === id).targets.map((t) => `${t.platform}:${t.kind}`).sort();

test('every platform lists the aspect ratios it accepts, as plain "w:h" options', () => {
  for (const [p, kinds] of Object.entries(MEDIA_SPECS)) {
    for (const [k, spec] of Object.entries(kinds)) {
      assert.ok(Array.isArray(spec.aspects) && spec.aspects.length > 0, `${p}.${k} aspects`);
      for (const a of spec.aspects) assert.match(a, /^\d+:\d+$/, `${p}.${k}: ${a}`);
    }
  }
});

test('the lists are exactly the founder\'s rules', () => {
  assert.deepEqual(MEDIA_SPECS.ig.reel.aspects, ['9:16', '16:9']);
  assert.deepEqual(MEDIA_SPECS.ig.carousel.aspects, ['1:1', '4:5']);
  assert.deepEqual(MEDIA_SPECS.tt.video.aspects, ['9:16']);
  assert.deepEqual(MEDIA_SPECS.yt.short.aspects, ['9:16']);
  assert.deepEqual(MEDIA_SPECS.yt.video.aspects, ['16:9']);
});

test('a SQUARE (1:1) file is not accepted for an IG reel or a YouTube Short', () => {
  for (const target of [T('ig', 'reel'), T('yt', 'short')]) {
    const plan = assignFiles({ files: [square], targets: [target] });
    assert.equal(plan.problems.length, 1, `${target.platform}:${target.kind}`);
    assert.deepEqual(plan.stored, []);
  }
});

test('an IG reel still accepts both vertical and 16:9, but nothing in between', () => {
  assert.deepEqual(assignFiles({ files: [vertical], targets: [T('ig', 'reel')] }).problems, []);
  assert.deepEqual(assignFiles({ files: [landscape], targets: [T('ig', 'reel')] }).problems, []);
  const fourFive = file('f', 1080, 1350); // 4:5, the gap between vertical and square
  assert.equal(assignFiles({ files: [fourFive], targets: [T('ig', 'reel')] }).problems.length, 1);
});

test('an IG carousel takes 1:1 and 4:5 for now, and not vertical or landscape', () => {
  assert.deepEqual(assignFiles({ files: [square], targets: [T('ig', 'carousel')] }).problems, []);
  assert.deepEqual(assignFiles({ files: [file('f', 1080, 1350)], targets: [T('ig', 'carousel')] }).problems, []);
  assert.equal(assignFiles({ files: [vertical], targets: [T('ig', 'carousel')] }).problems.length, 1);
  assert.equal(assignFiles({ files: [landscape], targets: [T('ig', 'carousel')] }).problems.length, 1);
});

test('ONE vertical file serves IG reel + TikTok + YouTube Short, and is stored once', () => {
  const plan = assignFiles({ files: [vertical], targets: [T('ig', 'reel'), T('tt', 'video'), T('yt', 'short')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(stored(plan), ['v']);
  assert.deepEqual(usedBy(plan, 'v'), ['ig:reel', 'tt:video', 'yt:short']);
});

test('a landscape file serves IG reel + YouTube video — and NOT TikTok, which is vertical-only', () => {
  const plan = assignFiles({ files: [landscape], targets: [T('ig', 'reel'), T('yt', 'video')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(stored(plan), ['l']);
  assert.deepEqual(usedBy(plan, 'l'), ['ig:reel', 'yt:video']);

  const tt = assignFiles({ files: [landscape], targets: [T('tt', 'video')] });
  assert.equal(tt.problems.length, 1);
  assert.match(tt.problems[0], /TikTok/);
});

test('a vertical AND a landscape file: the Short takes the vertical, the YouTube video the landscape, IG reel shares one — 2 stored, not 3', () => {
  const plan = assignFiles({ files: [vertical, landscape], targets: [T('ig', 'reel'), T('yt', 'short'), T('yt', 'video')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(stored(plan).sort(), ['l', 'v']);
  assert.equal(plan.assignments['yt:short'], 'v');
  assert.equal(plan.assignments['yt:video'], 'l');
  assert.equal(plan.assignments['ig:reel'], 'v', 'tie between files: the one nearest the platform\'s native aspect');
});

test('a file no target needs is NOT stored and is reported unused', () => {
  const plan = assignFiles({ files: [vertical, landscape], targets: [T('ig', 'reel')] });
  assert.deepEqual(stored(plan), ['v']);
  assert.deepEqual(plan.unused, ['l']);
});

test('a target no supplied file fits is a problem naming the platform, what it needs and what was supplied', () => {
  const plan = assignFiles({ files: [landscape], targets: [T('yt', 'short')] });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /YouTube short/);
  assert.match(plan.problems[0], /9:16/, 'names the accepted aspect ratio');
  assert.match(plan.problems[0], /l\b/, 'names the file that was tried');
  assert.deepEqual(plan.stored, []);
});

test('a hard limit makes a file ineligible for that platform only: an 11-minute vertical file cannot go to TikTok but can go to IG', () => {
  const long = file('long', 1080, 1920, { durationSec: 660 });
  const plan = assignFiles({ files: [long], targets: [T('tt', 'video'), T('ig', 'reel')] });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /TikTok.*600/s);
});

test('a file under TikTok\'s 360px minimum is ineligible for TikTok', () => {
  const tiny = file('tiny', 240, 426);
  const plan = assignFiles({ files: [tiny], targets: [T('tt', 'video')] });
  assert.match(plan.problems[0], /360/);
});

test('a second, eligible file rescues a target the first cannot serve, and serves both so only one is stored', () => {
  const long = file('long', 1080, 1920, { durationSec: 660 });
  const short = file('short', 1080, 1920, { durationSec: 90 });
  const plan = assignFiles({ files: [long, short], targets: [T('tt', 'video'), T('ig', 'reel')] });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.assignments['tt:video'], 'short');
  assert.deepEqual(stored(plan), ['short'], 'the short file fits both, so the long one is not stored');
});

test('duplicate targets are collapsed', () => {
  const plan = assignFiles({ files: [vertical], targets: [T('ig', 'reel'), T('ig', 'reel')] });
  assert.equal(plan.stored[0].targets.length, 1);
});

test('no targets: nothing stored, every file unused', () => {
  const plan = assignFiles({ files: [vertical], targets: [] });
  assert.deepEqual(plan.stored, []);
  assert.deepEqual(plan.unused, ['v']);
});

test('an unknown platform or kind is a problem that names what IS supported', () => {
  const a = assignFiles({ files: [vertical], targets: [T('myspace', 'reel')] });
  assert.match(a.problems[0], /myspace.*Supported.*ig/s);
  const b = assignFiles({ files: [vertical], targets: [T('ig', 'podcast')] });
  assert.match(b.problems[0], /podcast.*ig.*reel/s);
});

test('malformed files are problems, never NaN aspects', () => {
  for (const bad of [null, {}, { id: 'x', width: 0, height: 1920 }, { id: 'x', width: 1080, height: -1 }, { id: 'x', width: 'a', height: 2 }, { width: 10, height: 20 }]) {
    const plan = assignFiles({ files: [bad], targets: [T('ig', 'reel')] });
    assert.ok(plan.problems.length >= 1, JSON.stringify(bad));
    assert.deepEqual(plan.stored, []);
  }
});

test('duplicate file ids are a problem — an id must name exactly one file', () => {
  const plan = assignFiles({ files: [file('a', 1080, 1920), file('a', 1920, 1080)], targets: [T('ig', 'reel')] });
  assert.match(plan.problems[0], /duplicate.*a/i);
});

test('no files at all is a problem, not an empty success', () => {
  const plan = assignFiles({ files: [], targets: [T('ig', 'reel')] });
  assert.ok(plan.problems.length >= 1);
});

test('"vertical" means 9:16 exactly (±2% for encoder rounding), not anything tall', () => {
  const ok = [file('a', 1080, 1920), file('b', 720, 1280), file('c', 1080, 1918), file('d', 2160, 3840)];
  const no = [file('tall', 1080, 2160), file('threeFive', 1080, 1800), file('fourFive', 1080, 1350)]; // 1:2, 3:5, 4:5
  for (const target of [T('tt', 'video'), T('yt', 'short'), T('ig', 'reel')]) {
    for (const f of ok) assert.deepEqual(assignFiles({ files: [f], targets: [target] }).problems, [], `${f.id} for ${target.platform}`);
    for (const f of no) assert.equal(assignFiles({ files: [f], targets: [target] }).problems.length, 1, `${f.id} for ${target.platform}`);
  }
});

// ── Story media: advisory aspect (warn, never reject), hard duration / size limits ───────────────────
import { judgeFile } from './media-specs.js';

const img = (over = {}) => ({ kind: 'image', width: 1080, height: 1920, bytes: 2e6, ...over });
const vid = (over = {}) => ({ kind: 'video', width: 1080, height: 1920, durationSec: 30, bytes: 20e6, ...over });

test('IG story spec: 9:16 is preferred but ADVISORY; video 3-60s; image 8MB, video 100MB', () => {
  const s = MEDIA_SPECS.ig.story;
  assert.deepEqual(s.aspects, ['9:16']);
  assert.equal(s.aspectAdvisory, true);
  assert.equal(s.maxDurationSec, 60);
  assert.equal(s.minDurationSec, 3);
  assert.deepEqual(s.maxBytesByKind, { image: 8 * 1024 ** 2, video: 100 * 1024 ** 2 });
});

test('judgeFile: a 1080x1920 story image and a 30s vertical video are clean', () => {
  assert.deepEqual(judgeFile('ig', 'story', img()), { problems: [], warnings: [] });
  assert.deepEqual(judgeFile('ig', 'story', vid()), { problems: [], warnings: [] });
});

test('judgeFile: a non-9:16 story is accepted with a letterbox WARNING, not a problem', () => {
  const r = judgeFile('ig', 'story', img({ width: 1080, height: 1080 }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /letterbox/i);
  assert.match(r.warnings[0], /9:16/);
});

test('judgeFile: video over 60s or under 3s is a problem', () => {
  assert.match(judgeFile('ig', 'story', vid({ durationSec: 61 })).problems[0], /60s/);
  assert.match(judgeFile('ig', 'story', vid({ durationSec: 2 })).problems[0], /3s/);
  assert.deepEqual(judgeFile('ig', 'story', vid({ durationSec: 60 })).problems, []);
});

test('judgeFile: duration limits never apply to an image; size limits are per kind', () => {
  assert.deepEqual(judgeFile('ig', 'story', img({ durationSec: 999 })).problems, []);
  assert.match(judgeFile('ig', 'story', img({ bytes: 9 * 1024 ** 2 })).problems[0], /8 ?MB|limit/);
  assert.deepEqual(judgeFile('ig', 'story', vid({ bytes: 9 * 1024 ** 2 })).problems, []);
  assert.match(judgeFile('ig', 'story', vid({ bytes: 101 * 1024 ** 2 })).problems[0], /limit/);
});

test('judgeFile: a platform/kind with no spec judges nothing (generic, platform-agnostic)', () => {
  assert.deepEqual(judgeFile('fb', 'story', img()), { problems: [], warnings: [] });
  assert.deepEqual(judgeFile('ig', 'nope', img()), { problems: [], warnings: [] });
});

test('assignFiles: an advisory-aspect target (IG story) accepts any ratio rather than reporting "none fits"', () => {
  const plan = assignFiles({ files: [square], targets: [T('ig', 'story')] });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(stored(plan), ['s']);
});
