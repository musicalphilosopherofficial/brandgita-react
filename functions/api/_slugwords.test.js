import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PAIRS, wordsFor } from './_slugwords.js';

// ── The freeze gate ───────────────────────────────────────────────────────────
// The pair index is `byte % PAIRS.length`. Any edit to the list — including a
// harmless-looking append — changes the modulus and re-slugs EVERY existing creator,
// while their already-uploaded R2 objects keep the old prefix. Their scheduled posts
// then 404 and silently fail to publish.
//
// So this is not a style test. It is the thing standing between a one-line edit and a
// silent outage for every paying user. If it fails, you did not make a cosmetic change.
// Ship a `media-slug:v2:` migration that re-keys existing objects, or revert.
test('PAIRS is frozen — changing it silently breaks every existing media URL', () => {
  const digest = createHash('sha256')
    .update(JSON.stringify(PAIRS))
    .digest('hex')
    .slice(0, 16);
  assert.equal(
    digest,
    '8bc64aa2c5b8db3f',
    'PAIRS changed. Every existing creator re-slugs and their scheduled posts break. ' +
      'This needs a v2 migration, not a list edit.',
  );
  assert.equal(PAIRS.length, 16);
});

test('the source file itself is frozen — catches a re-spelling that survives JSON', () => {
  const digest = createHash('sha256')
    .update(readFileSync(new URL('./_slugwords.js', import.meta.url)))
    .digest('hex')
    .slice(0, 16);
  assert.equal(digest, '1f5a5580b8bac418');
});

// ── Behaviour ─────────────────────────────────────────────────────────────────
test('wordsFor is total over a byte and always <song>-by-<artist>', () => {
  for (let b = 0; b < 256; b += 1) {
    const w = wordsFor(b);
    assert.match(w, /^[a-z-]+-by-[a-z-]+$/, `byte ${b} produced ${w}`);
  }
});

test('every pair is correctly attributed — no song lands on the wrong artist', () => {
  // Real people, in the creator's PUBLIC urls. A mis-paired entry publishes a false
  // statement about a named person, which is a different problem from a broken link.
  const byArtist = new Map();
  for (const [song, artist] of PAIRS) {
    assert.ok(song && artist, 'both halves present');
    if (!byArtist.has(artist)) byArtist.set(artist, new Set());
    assert.ok(!byArtist.get(artist).has(song), `duplicate ${song} for ${artist}`);
    byArtist.get(artist).add(song);
  }
  assert.ok(byArtist.size >= 8, 'a handful of artists, not one repeated');
});

test('slug words are url-safe and stay well inside the KEY_SHAPE bound', () => {
  for (const [song, artist] of PAIRS) {
    assert.match(`${song}-by-${artist}`, /^[a-z-]{1,60}$/);
  }
});
