// mediaUrl must produce a URL the PUBLIC media route can actually serve.
// Run: node --test cron-worker/util.mediaurl.test.js
//
// Audit trail (2026-10-02): the first real scheduled reel failed with Instagram container
// status ERROR and no reason. mediaUrl kept the key's slashes literal, so Instagram was sent
// /api/media/<uid>/reel/<file>.mp4 — but functions/api/media/[key].js matches ONE path segment,
// so that URL fell through to the site's index.html (200 text/html) and Instagram was handed
// HTML instead of a video. The route, the desktop's upload_url and every other caller encode
// the whole key as a single segment (%2F); this pins the poster to the same shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, MEDIA_BASE } from './util.js';

test('a key with slashes is encoded as ONE path segment', () => {
  assert.equal(
    mediaUrl('28454643674205484/reel/abc.mp4'),
    `${MEDIA_BASE}/28454643674205484%2Freel%2Fabc.mp4`
  );
});

test('the URL has exactly one segment after the base (what the [key] route matches)', () => {
  const rest = mediaUrl('uid/cover/x.jpg').slice(MEDIA_BASE.length + 1);
  assert.equal(rest.includes('/'), false);
});

test('special characters in a key are still encoded', () => {
  assert.equal(mediaUrl('a b/c?d.mp4'), `${MEDIA_BASE}/a%20b%2Fc%3Fd.mp4`);
});
