/**
 * POST /api/bugreport/media?kind={recording|screenshot|voice} — store one piece of
 * creator-captured media for a bug report.
 *
 * Steps 3–5 of the build order in decisions/in-app-bug-reporting.md (screenshot,
 * recording, voice) collapse into ONE route, because they are one trust boundary: media
 * the creator captured in-app, leaving the machine only on an explicit decision. Three
 * routes would have been three places to get auth right. See _media.js#MEDIA_KINDS for
 * what differs per kind (content types, size cap, daily quota) — and note that nothing
 * about AUTH differs, deliberately.
 *
 * That build order named three prerequisites before any of it could leave the machine:
 *
 *   a private bucket with an authenticated GET   this route + media/[key].js
 *   preview-before-send                          the desktop client (publish.js)
 *   window-scoped capture, not full-screen       electron-shell/screen-recording-bridge.js
 *
 * WHY THE BYTES DO NOT RIDE INSIDE THE BUG REPORT
 * -----------------------------------------------
 * The obvious shape is one request: base64 the recording into submitBugReport's existing
 * JSON body. It was rejected for three separate reasons, any one of which is enough.
 *
 *   1. base64 inflates by a third, and a Worker would have to hold the decoded blob in
 *      memory to write it. A 100 MB recording is an OOM, not a slow request.
 *   2. /api/bugreport validates text, scans for credentials and checks quota BEFORE it
 *      writes anything. Every one of those cheap rejections would sit behind a
 *      multi-megabyte upload the creator already paid to send.
 *   3. It would put raw content in the report body. The report carries a coarse
 *      REFERENCE — an opaque key — exactly as electron-shell/bugreport.js's allowlist
 *      model already carries `job_ref` rather than a working directory.
 *
 * So: upload first, get an opaque key back, then file the report citing the key.
 *
 * AUTH — the licence, matching /api/bugreport
 * -------------------------------------------
 * NOT requireUserAuth. The bearer token resolves an ig_user_id, and the single most
 * valuable bug report is "the app broke during onboarding" — from a creator with no
 * connected Instagram account and therefore no bearer token. The licence exists from
 * first launch, so it is the identity that covers the whole lifecycle. Same call, same
 * fail-closed posture, and the same seam (`env.__checkWhopLicense`) for tests.
 *
 * The licence travels in `X-License-Key`, not in the body, because the body is the file.
 */

import { checkWhopLicense } from '../_whop.js';
import { MEDIA_KINDS, bugMediaSlug, dayPrefix, mintMediaKey } from './_media.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-License-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const licenseKey = request.headers.get('X-License-Key');
  if (!licenseKey) {
    return json({ ok: false, error: 'X-License-Key is required' }, 401);
  }

  // The kind is declared, not inferred. A `.webm` is a screen recording or a voice note
  // depending only on how it was captured, and the client renders its preview from the
  // kind — so guessing it from the content type would produce a preview that silently
  // does not play, in the one dialog whose entire purpose is showing the creator what
  // they are about to send.
  const kind = new URL(request.url).searchParams.get('kind') || 'recording';
  const spec = Object.prototype.hasOwnProperty.call(MEDIA_KINDS, kind) ? MEDIA_KINDS[kind] : null;
  if (!spec) {
    return json(
      { ok: false, error: `kind must be one of: ${Object.keys(MEDIA_KINDS).join(', ')}` },
      400,
    );
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext = spec.types.get(contentType);
  if (!ext) {
    // An allowlist per kind, not a denylist and not a shared "any media" set. The bucket
    // is served from the apex domain by the sibling public route, so storing arbitrary
    // content types here would be a way to host HTML/JS under our own origin — and a
    // video accepted under `kind=screenshot` would defeat the per-kind size cap below.
    return json({ ok: false, error: 'Unsupported media type for this kind' }, 415);
  }

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared && declared > spec.maxBytes) {
    // Reject before reading a byte when the client tells us how big it is.
    return json({ ok: false, error: 'Upload is too large' }, 413);
  }

  // ── entitlement, before any storage I/O — fails closed ────────────────────
  const check = env.__checkWhopLicense || checkWhopLicense;
  const licence = await check(licenseKey, env);
  if (!licence.ok) {
    return json({ ok: false, error: licence.error || 'Licence check failed' }, licence.status || 403);
  }

  let slug;
  try {
    slug = await bugMediaSlug(env, licence.membershipId || 'unknown');
  } catch (err) {
    // No secret configured. Refuse rather than fall back to a constant prefix that would
    // put every creator's recordings in one mutually-readable namespace.
    console.error('bugreport/media: slug derivation failed', { message: err?.message });
    return json({ ok: false, error: 'Media storage is not configured' }, 503);
  }

  // ── per-membership daily quota, counted from storage itself ───────────────
  // Keys embed the UTC day, so today's uploads are one prefixed list() away and no
  // counter table (and no migration) is needed. Fails CLOSED, matching /api/bugreport's
  // quota rather than _ratelimit.js: the downstream cost here is storage on our bill.
  try {
    const listed = await env.SCHEDULE_BUCKET.list({
      prefix: dayPrefix(slug, kind),
      limit: spec.dailyQuota + 1,
    });
    if (((listed && listed.objects) || []).length >= spec.dailyQuota) {
      return json(
        { ok: false, error: `Daily limit of ${spec.dailyQuota} ${kind} uploads reached.` },
        429,
      );
    }
  } catch (err) {
    console.error('bugreport/media: quota list failed', { message: err?.message });
    return json({ ok: false, error: 'Could not verify upload quota' }, 503);
  }

  // ── read the body under a hard ceiling ────────────────────────────────────
  // Buffered, not streamed. The public route streams with `expectedLength` because a
  // 600 MB reel cannot be held in memory; at these caps buffering is affordable and removes
  // the whole class of bug that route hit in production (a piped stream loses the length
  // R2 requires, and every real upload 500s). Simplicity is worth more here than the
  // last megabyte of headroom.
  let bytes;
  try {
    bytes = await request.arrayBuffer();
  } catch (err) {
    console.error('bugreport/media: body read failed', { message: err?.message });
    return json({ ok: false, error: 'Could not read the upload' }, 400);
  }
  if (!bytes || bytes.byteLength === 0) {
    return json({ ok: false, error: 'Upload is empty' }, 400);
  }
  // Re-check against the ACTUAL size — a declared Content-Length is a claim, not a fact.
  if (bytes.byteLength > spec.maxBytes) {
    return json({ ok: false, error: 'Upload is too large' }, 413);
  }

  const key = mintMediaKey(slug, kind, ext);

  try {
    await env.SCHEDULE_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    // External-I/O failure path must log.
    console.error('bugreport/media: R2 put failed', { kind, message: err?.message });
    return json({ ok: false, error: 'Could not store the upload' }, 500);
  }

  // The key only. No URL — the caller composes one against its own CLOUD_BASE, and
  // handing back a fully-formed link invites treating it as shareable, which is exactly
  // what this route exists to stop.
  return json({ ok: true, media_key: key, kind, bytes: bytes.byteLength });
}
