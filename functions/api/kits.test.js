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

// ── Voice Gita — the third gita, added 2026-09-12 (migration 0015) ────────────────────────
//
// Founder: "bring it to a point of a strong first prototype that works end to end with our
// cloudflare component that has the 2 gitas and now voice gita per user."
//
// Voice belongs beside vision and aesthetic for the reason 0014 already gives: it is the output
// of material the creator recorded once, and losing it means speaking it all again. What makes
// it safe to store is that it is BOUNDED by construction — seven slots, three specimens each,
// one sentence each — so unlike a transcript store this column cannot grow with the corpus.

const VOICE = JSON.stringify({
  creator: 'duncan',
  slots: {
    sentence_habit: [{ text: 'Sharpening. Nobody sharpens.', source: 'interview', weight: 0.9 }],
  },
});

test('a voice profile syncs alongside the other two gitas', () => {
  const { kit, error } = sanitiseKit({ ...KIT, voice_gita: VOICE });
  assert.strictEqual(error, undefined);
  assert.strictEqual(kit.voice_gita, VOICE);
});

test('voice_gita is one of the synced fields and is not silently dropped', () => {
  assert.ok(SYNCED_FIELDS.includes('voice_gita'));
});

test('a creator who has never spoken still syncs their kit', () => {
  // Voice is optional by design — the tab is opt-in and most creators will not have used it.
  const { kit, error } = sanitiseKit(KIT);
  assert.strictEqual(error, undefined);
  assert.strictEqual(kit.voice_gita, null);
});

test('a malformed voice profile is refused at write time, not discovered at read time', () => {
  // Same argument as brand_spec: storing corrupt JSON means it fails on every future sync down,
  // and the creator's working copy gets overwritten by something unparseable.
  assert.match(sanitiseKit({ ...KIT, voice_gita: '{not json' }).error, /valid JSON/);
});

test('a voice profile is small enough that it cannot be what blows the kit ceiling', () => {
  // VoiceGita.MAX_RENDERED_CHARS is under 2 KB; the JSON around it is a small multiple.
  assert.ok(VOICE.length < 4096, `voice payload was ${VOICE.length} bytes`);
});

test('a client sending raw recorded material gets it dropped, not stored', () => {
  // Only the creator's own recordings may teach a voice, and keeping the corpus server-side
  // would turn a bounded profile into an unbounded archive of someone talking about themselves.
  const { kit } = sanitiseKit({ ...KIT, voice_gita: VOICE, voice_corpus: 'an hour of transcript' });
  assert.ok(!('voice_corpus' in kit));
});
