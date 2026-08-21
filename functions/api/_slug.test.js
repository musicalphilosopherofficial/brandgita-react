import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSlug } from './_auth.js';

const ID = '17841400000000001';

test('deterministic, distinct per user, sensitive to the secret', async () => {
  const a = await mediaSlug({ API_SECRET: 's1' }, ID);
  assert.equal(a, await mediaSlug({ API_SECRET: 's1' }, ID), 'same input, same slug');
  assert.notEqual(a, await mediaSlug({ API_SECRET: 's1' }, '17841400000000002'));
  assert.notEqual(a, await mediaSlug({ API_SECRET: 's2' }, ID));
});

test('publishes no substring of the ig_user_id', async () => {
  const slug = await mediaSlug({ API_SECRET: 's1' }, ID);
  for (const n of [6, 8, 10, 12, 17]) {
    assert.ok(!slug.includes(ID.slice(0, n)), `leaks prefix of length ${n}`);
    assert.ok(!slug.includes(ID.slice(-n)), `leaks suffix of length ${n}`);
  }
});

test('shape is <words>-<20 hex>, 80 bits of entropy in the hex', async () => {
  const slug = await mediaSlug({ API_SECRET: 's1' }, ID);
  assert.match(slug, /^[a-z-]+-by-[a-z-]+-[0-9a-f]{20}$/);
  assert.equal(slug.split('-').pop().length, 20);
});

// ── The rotation deadlock this binding exists to break ────────────────────────
// API_SECRET gates /api/token and mints tokens for any user, so it must stay
// rotatable. Before MEDIA_SLUG_SECRET existed, rotating it re-slugged every creator
// while their R2 objects kept the old prefix — every scheduled post would 404.
test('MEDIA_SLUG_SECRET lets API_SECRET rotate without re-slugging anyone', async () => {
  const pinned = { MEDIA_SLUG_SECRET: 'slug-key', API_SECRET: 'original' };
  const before = await mediaSlug(pinned, ID);
  const after = await mediaSlug({ ...pinned, API_SECRET: 'ROTATED' }, ID);
  assert.equal(after, before, 'rotating API_SECRET must not move any media');
});

test('falls back to API_SECRET so existing slugs are unchanged until cut over', async () => {
  assert.equal(
    await mediaSlug({ API_SECRET: 's1' }, ID),
    await mediaSlug({ MEDIA_SLUG_SECRET: undefined, API_SECRET: 's1' }, ID),
  );
});

test('setting MEDIA_SLUG_SECRET IS a re-key event — proven, not assumed', async () => {
  // This test documents the hazard rather than guarding against it: the cutover must
  // happen while the bucket is effectively empty, or be paired with a re-key pass.
  const fallback = await mediaSlug({ API_SECRET: 's1' }, ID);
  const cutover = await mediaSlug({ MEDIA_SLUG_SECRET: 'new-key', API_SECRET: 's1' }, ID);
  assert.notEqual(cutover, fallback, 'if these ever match, the binding is being ignored');
});

test('refuses to invent a slug when no secret is configured', async () => {
  await assert.rejects(() => mediaSlug({}, ID), /required to derive a media slug/);
});
