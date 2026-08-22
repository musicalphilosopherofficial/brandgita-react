// cron-worker/util.js
//
// Generic (not Instagram-specific) helpers shared between cron-worker/poster.js
// and every platform adapter under cron-worker/platforms/. Deliberately a
// standalone leaf module with NO imports of its own.
//
// WHY THIS FILE EXISTS (found empirically, not assumed — same discipline as
// the shared/platform-contracts.js import spike): mediaUrl/nowIso used to live
// directly in poster.js, with platforms/instagram.js importing them back from
// there. That is a circular import (poster.js -> platforms/index.js ->
// platforms/instagram.js -> poster.js), and circular ES module graphs only
// resolve correctly when the entry point happens to start evaluation on the
// side of the cycle that reaches the binding's initializer before anything
// reads it. That held for poster.js — the Worker's real entry point, and
// poster.test.js's first import — so the tests passed. But importing
// platforms/instagram.js directly (e.g. a future test that unit-tests the
// adapter in isolation, without going through poster.js first) throws
// "Cannot access 'instagram' before initialization" — confirmed with a plain
// `node -e "import('./cron-worker/platforms/instagram.js')"` before this file
// existed. Rather than ship a landmine that only works by accident of which
// file happens to be the entry point, these two helpers live here instead:
// both poster.js and every adapter import this leaf directly, with no cycle
// possible.

export const MEDIA_BASE = 'https://brandgita.com/api/media';

export function nowIso() {
  return new Date().toISOString();
}

// Turns an R2 object key into a public https URL under mediaBase. Generic
// infrastructure any platform's adapter needs — a public URL for the asset
// it's about to publish — not just an Instagram fact.
export function mediaUrl(key, mediaBase = MEDIA_BASE) {
  // key may contain slashes (e.g. "user123/clip.mp4"); encode each segment so
  // the path stays valid while preserving the directory structure.
  const encoded = String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${mediaBase}/${encoded}`;
}
