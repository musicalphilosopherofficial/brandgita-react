// The ONE key shape both media routes (public GET/PUT and multipart upload) accept.
// Run: node --test functions/api/media-key-shape.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_SHAPE, KEY_FOLDERS } from './media/[key].js';

const SLUG = '0123456789abcdef0123';

test('every content folder is accepted: reel, cover, carousel and story', () => {
  for (const f of ['reel', 'cover', 'carousel', 'story']) {
    assert.ok(KEY_SHAPE.test(`${SLUG}/${f}/pic.jpg`), f);
  }
  assert.deepEqual([...KEY_FOLDERS].sort(), ['carousel', 'cover', 'reel', 'story']);
});

test('a story key may be a .jpg image or an .mp4 video, under a slug or legacy numeric prefix', () => {
  assert.ok(KEY_SHAPE.test(`${SLUG}/story/pic.jpg`));
  assert.ok(KEY_SHAPE.test(`${SLUG}/story/clip.mp4`));
  assert.ok(KEY_SHAPE.test(`12345/story/pic.jpg`));
  assert.ok(KEY_SHAPE.test(`some-song-by-artist-${SLUG}/story/pic.jpg`));
});

test('unknown folders, traversal and bug-report keys are still refused', () => {
  for (const bad of [`${SLUG}/stories/a.jpg`, `${SLUG}/story/../a.jpg`, `${SLUG}/story/a.gif`, `${SLUG}/voice/a.jpg`, 'bugreport/x/story/a.jpg', `${SLUG}/story/`]) {
    assert.equal(KEY_SHAPE.test(bad), false, bad);
  }
});
