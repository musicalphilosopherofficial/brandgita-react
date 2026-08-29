// Unit tests — /api/kits: a creator's brand IP, kept so they cannot lose it.
//
// Layer (philosophy/testing-bdd-vs-tdd.md): TDD unit. isValidSlug and sanitiseKit are pure
// functions over a request body; the D1 half is exercised against the real binding in staging.
//
// WHY THIS EXISTS (founder, 2026-08-30): "the intellectual property aesthetic and vision should
// be in cloudflare." Only that — ~32 KB of text per brand (vision-gita.md, aesthetic-gita.md,
// brand-spec.json), which is the part that cannot be reproduced if it is lost. Fonts are
// licensed third-party binaries and stay local; tokens.css and index.html are derived from
// brand-spec.json and are regenerated, because a synced derivative eventually disagrees with
// its source.

import { test } from 'node:test';
import assert from 'node:assert';

import { isValidSlug, sanitiseKit, SYNCED_FIELDS, MAX_KIT_BYTES } from './kits.js';

const KIT = {
  vision_gita: '# Vision\nA polymath who teaches on camera.',
  aesthetic_gita: '# Aesthetic\nNo glow. Warm neutrals.',
  brand_spec: JSON.stringify({ creator_name: 'Test', ink_color: '#111' }),
};

// ── slugs ─────────────────────────────────────────────────────────────────────

test('a normal kit slug is accepted', () => {
  assert.ok(isValidSlug('musical-philosopher'));
  assert.ok(isValidSlug('karma-os'));
  assert.ok(isValidSlug('brand-gita'));
});

test('a slug that could escape a directory is refused', () => {
  // The load-bearing one. The slug becomes a DIRECTORY NAME when this syncs down to the
  // creator's disk, so a traversal stored here is a traversal executed on the other side of
  // the wire. Refusing it at the door is cheaper than trusting every future client.
  for (const bad of ['../etc', 'a/b', './x', '..', 'a\\b', '/abs']) {
    assert.ok(!isValidSlug(bad), `${bad} was accepted`);
  }
});

test('an empty, oversized or wrongly-typed slug is refused', () => {
  for (const bad of ['', '-leading', 'UPPER', 'a'.repeat(65), null, undefined, 7]) {
    assert.ok(!isValidSlug(bad), `${JSON.stringify(bad)} was accepted`);
  }
});

// ── what syncs ────────────────────────────────────────────────────────────────

test('the three IP files are stored', () => {
  const { kit } = sanitiseKit(KIT);
  assert.strictEqual(kit.vision_gita, KIT.vision_gita);
  assert.strictEqual(kit.aesthetic_gita, KIT.aesthetic_gita);
  assert.strictEqual(kit.brand_spec, KIT.brand_spec);
});

test('anything NOT in the synced set is dropped, not stored', () => {
  // Default-deny. A client that starts sending fonts or a whole tokens.css must not quietly
  // turn this into the asset store it is explicitly not — fonts are licensed binaries, and
  // tokens.css is derived from brand_spec.
  const { kit } = sanitiseKit({ ...KIT, tokens_css: ':root{}', fonts: 'base64…', index_html: '<p>' });
  assert.deepStrictEqual(Object.keys(kit).sort(), [...SYNCED_FIELDS].sort());
});

test('a partial kit is allowed — a creator mid-interview has only some of it', () => {
  const { kit, error } = sanitiseKit({ vision_gita: '# Vision only' });
  assert.ok(!error);
  assert.strictEqual(kit.vision_gita, '# Vision only');
  assert.strictEqual(kit.aesthetic_gita, null);
});

test('an entirely empty kit is refused rather than stored as a blank row', () => {
  // A blank row would sync down and overwrite a good local copy with nothing.
  assert.match(sanitiseKit({}).error, /at least one file/);
  assert.match(sanitiseKit({ vision_gita: null, aesthetic_gita: null, brand_spec: null }).error,
    /at least one file/);
});

test('a non-string field is refused rather than coerced', () => {
  assert.match(sanitiseKit({ ...KIT, vision_gita: { md: 'x' } }).error, /must be text/);
});

// ── limits and integrity ──────────────────────────────────────────────────────

test('an oversized kit is NAMED, never silently truncated', () => {
  // Truncating would sync back down and overwrite the creator's full aesthetic-gita with the
  // shortened one — data loss wearing a success response.
  const huge = { vision_gita: 'x'.repeat(MAX_KIT_BYTES + 1) };
  const res = sanitiseKit(huge);
  assert.ok(!res.kit);
  assert.match(res.error, /limit is/);
});

test('a kit at exactly the limit is still accepted', () => {
  assert.ok(sanitiseKit({ vision_gita: 'x'.repeat(MAX_KIT_BYTES) }).kit);
});

test('a malformed brand_spec is refused at write time, not discovered at read time', () => {
  // Stored corrupt, it would fail on EVERY future sync down — on a machine where the creator
  // has no idea what went wrong and no way to fix it.
  assert.match(sanitiseKit({ ...KIT, brand_spec: '{not json' }).error, /valid JSON/);
});

test('a body that is not an object at all is refused', () => {
  for (const bad of [null, undefined, 'a string', 42]) {
    assert.ok(sanitiseKit(bad).error, `${JSON.stringify(bad)} was accepted`);
  }
});
