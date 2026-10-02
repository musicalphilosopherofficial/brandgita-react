/**
 * /api/media-upload/{key} — chunked (R2 multipart) upload for files over Cloudflare's
 * 100 MB single-request limit.
 *
 * WHY: functions/api/media/[key].js accepts up to 600 MB, but Cloudflare's edge rejects any
 * single request body over 100 MB on the Free/Pro plan before it reaches a Function (a 224 MB
 * reel was refused, 2026-10-02). Splitting the file into parts, each its own request, stays
 * under that limit with no plan change. R2 stitches the parts into one ordinary object, so
 * the cron poster and Instagram fetch it exactly like a small upload.
 *
 * PROTOCOL (all calls: Authorization: Bearer <desktop_token>)
 *   POST   ?action=create    { content_type, size }              → { upload_id, part_size }
 *   PUT    ?upload_id=&part= <raw chunk bytes>                   → { part, etag, size }
 *   POST   ?action=complete  { upload_id, size, parts:[{part,etag}] } → { ok, key }
 *   DELETE ?upload_id=                                           → { ok }
 *
 * INTEGRITY, WITHOUT SERVER CPU. The Free plan gives a Function ~10 ms of CPU per request,
 * which hashing a multi-MB chunk could exceed. So the server does no hashing: R2 returns each
 * part's MD5 as its etag, and the DESKTOP compares that to the MD5 of the bytes it sent,
 * retrying a part that differs. On `complete` the server checks the assembled object's size
 * against the size declared at `create`; a mismatch DELETES the object (422) so a short or
 * corrupt video can never be left for Instagram to fetch or the scheduler to post.
 *
 * Auth, key shape, prefix tenancy and content-type allowlist are identical to the single-PUT
 * route — same constants, imported rather than copied, so they cannot drift apart.
 */

import { mediaSlug, requireUserAuth } from '../_auth.js';
import { ALLOWED_CONTENT_TYPES, KEY_SHAPE, MAX_BYTES } from '../media/[key].js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Every part but the last must be the same size and >= 5 MiB (R2 rule). 24 MiB keeps a
// 600 MB file to 25 requests and each request's body well under Cloudflare's 100 MB cap
// and a Function's 128 MB memory.
export const PART_SIZE = 24 * 1024 * 1024;
const MAX_PARTS = 10000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let key;
  try {
    key = decodeURIComponent(params.key);
  } catch {
    return json({ ok: false, error: 'Malformed key' }, 400);
  }
  // Bug-report media must never move through this route — see media/[key].js.
  if (key.startsWith('bugreport/') || !key || !KEY_SHAPE.test(key)) {
    return json({ ok: false, error: 'Invalid key' }, 400);
  }

  if (!['POST', 'PUT', 'DELETE'].includes(request.method)) {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;

  const slug = await mediaSlug(env, auth.ig_user_id);
  if (!key.startsWith(`${slug}/`) && !key.startsWith(`${auth.ig_user_id}/`)) {
    return json({ ok: false, error: 'You can only upload to your own user prefix' }, 403);
  }

  const url = new URL(request.url);
  const bucket = env.SCHEDULE_BUCKET;

  // ── POST — create / complete ──────────────────────────────────────────────
  if (request.method === 'POST') {
    const action = url.searchParams.get('action');
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400);
    }

    if (action === 'create') {
      const contentType = String(body.content_type || '').split(';')[0].trim();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return json({ ok: false, error: 'Unsupported media type' }, 415);
      }
      const size = body.size;
      if (!Number.isInteger(size) || size <= 0) {
        return json({ ok: false, error: 'size must be a positive integer (bytes)' }, 400);
      }
      if (size > MAX_BYTES) return json({ ok: false, error: 'File too large' }, 413);

      try {
        const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
        return json({ ok: true, upload_id: upload.uploadId, part_size: PART_SIZE });
      } catch (err) {
        console.error('media-upload: create failed', { message: err?.message });
        return json({ ok: false, error: 'Could not start the upload' }, 500);
      }
    }

    if (action === 'complete') {
      const { upload_id: uploadId, size, parts } = body;
      if (!uploadId || typeof uploadId !== 'string') {
        return json({ ok: false, error: 'upload_id is required' }, 400);
      }
      if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) {
        return json({ ok: false, error: 'size must be the declared file size in bytes' }, 400);
      }
      if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
        return json({ ok: false, error: 'parts must be a non-empty list' }, 400);
      }
      const ordered = [];
      for (const p of parts) {
        if (!p || !Number.isInteger(p.part) || p.part < 1 || p.part > MAX_PARTS || typeof p.etag !== 'string') {
          return json({ ok: false, error: 'each part needs a part number and etag' }, 400);
        }
        ordered.push({ partNumber: p.part, etag: p.etag });
      }
      ordered.sort((a, b) => a.partNumber - b.partNumber);

      let object;
      try {
        object = await bucket.resumeMultipartUpload(key, uploadId).complete(ordered);
      } catch (err) {
        console.error('media-upload: complete failed', { message: err?.message });
        return json({ ok: false, error: 'Could not assemble the upload — retry the missing parts' }, 500);
      }

      // The size check is the integrity gate: R2 assembled whatever parts it was given, and
      // only the byte count tells us whether that is the file the creator chose.
      const actual = object?.size ?? (await bucket.head(key))?.size;
      if (actual !== size) {
        try {
          await bucket.delete(key);
        } catch (err) {
          console.error('media-upload: could not delete a wrong-sized object', { key, message: err?.message });
        }
        return json({ ok: false, error: `Upload is ${actual} bytes but ${size} were declared — discarded` }, 422);
      }
      return json({ ok: true, key });
    }

    return json({ ok: false, error: 'action must be create or complete' }, 400);
  }

  // ── PUT — one part ────────────────────────────────────────────────────────
  if (request.method === 'PUT') {
    const uploadId = url.searchParams.get('upload_id');
    const part = Number(url.searchParams.get('part'));
    if (!uploadId) return json({ ok: false, error: 'upload_id is required' }, 400);
    if (!Number.isInteger(part) || part < 1 || part > MAX_PARTS) {
      return json({ ok: false, error: 'part must be an integer from 1 to 10000' }, 400);
    }
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > PART_SIZE) return json({ ok: false, error: 'Part too large' }, 413);

    let bytes;
    try {
      bytes = await request.arrayBuffer();
    } catch (err) {
      console.error('media-upload: part body read failed', { message: err?.message });
      return json({ ok: false, error: 'Could not read the part' }, 400);
    }
    if (bytes.byteLength === 0) return json({ ok: false, error: 'Part is empty' }, 400);
    if (bytes.byteLength > PART_SIZE) return json({ ok: false, error: 'Part too large' }, 413);

    try {
      const uploaded = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(part, bytes);
      return json({ ok: true, part, etag: uploaded.etag, size: bytes.byteLength });
    } catch (err) {
      console.error('media-upload: part failed', { part, message: err?.message });
      return json({ ok: false, error: 'Could not store the part' }, 500);
    }
  }

  // ── DELETE — abort ────────────────────────────────────────────────────────
  const uploadId = url.searchParams.get('upload_id');
  if (!uploadId) return json({ ok: false, error: 'upload_id is required' }, 400);
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
    return json({ ok: true });
  } catch (err) {
    console.error('media-upload: abort failed', { message: err?.message });
    return json({ ok: false, error: 'Could not cancel the upload' }, 500);
  }
}
