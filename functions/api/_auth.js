import { wordsFor } from './_slugwords.js';
/**
 * Per-user bearer token auth for desktop → cloud API calls.
 *
 * Usage in an endpoint:
 *   const auth = await requireUserAuth(request, env)
 *   if (auth.error) return auth.error          // 401 Response
 *   const { ig_user_id } = auth                // scoped to this user
 *
 * The desktop sends:  Authorization: Bearer <desktop_token>
 * Token is minted in POST /api/token after OAuth. We store ONLY the SHA-256 hash
 * of the token (never the live value), so a D1 read cannot yield usable tokens.
 * A token identifies exactly one ig_user_id — so every endpoint is automatically
 * scoped: users can only touch their own rows and R2 objects.
 */

// Max desktop-token lifetime. After this the user must reconnect (re-OAuth).
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** SHA-256 → lowercase hex. Used to hash bearer tokens before DB storage/lookup. */
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opaque per-user media slug — replaces the raw ig_user_id in public media URLs.
 *
 * THE PROBLEM: media keys were `{ig_user_id}/reel/{uuid}.mp4`, and those URLs are
 * public by design (Instagram fetches them without credentials). So every media URL
 * published the creator's Instagram account ID, and any two URLs sharing a prefix
 * proved they belonged to the same person. The uuid protected the FILE; nothing
 * protected the IDENTITY.
 *
 * HMAC rather than a random slug stored in D1, deliberately:
 *   - no new table, no migration, no extra read on the hot path
 *   - the server re-derives it from the AUTHENTICATED ig_user_id, so the prefix is
 *     still a real tenancy check rather than a value the client asserts
 *   - deterministic, so existing objects can be re-keyed by recomputation
 * It is not reversible, and it does not need to be: every call already knows the
 * ig_user_id from the bearer token.
 */
export async function mediaSlug(env, igUserId) {
  const secret = env.API_SECRET;
  if (!secret) throw new Error('API_SECRET is required to derive a media slug');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`media-slug:v1:${igUserId}`),
    ),
  );
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  // 20 hex chars = the first 10 bytes = 80 bits. THIS is the entire security of the
  // slug: unguessable, and unique enough that a collision is not a real event.
  const entropy = hex(sig.subarray(0, 10));

  // The words are DECORATION and carry no security weight — a 16-pair list is 4 bits,
  // and word-only slugs collide at ~100 users, which would be fatal because the prefix
  // IS the tenancy check. They are drawn from byte 10, disjoint from the 10 bytes above,
  // so the readable half reveals nothing that the visible hex does not already show.
  return `${wordsFor(sig[10])}-${entropy}`;
}

export async function requireUserAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { error: unauthorized('Missing or invalid Authorization header') };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: unauthorized('Empty bearer token') };
  }

  // Look up by HASH — the live token is never stored, so a DB leak is inert.
  // Comparing a 256-bit hash also removes the byte-by-byte timing oracle that a
  // plaintext-equality lookup on a secret column would expose.
  const tokenHash = await sha256Hex(token);

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT ig_user_id, desktop_token_created_at FROM ig_tokens WHERE desktop_token = ?`
    ).bind(tokenHash).first();
  } catch (err) {
    console.error('Auth token lookup failed:', { message: err?.message });
    return { error: serverError('Auth lookup failed') };
  }

  if (!row) {
    return { error: unauthorized('Invalid or expired token') };
  }

  // Enforce a maximum token age — no immortal sessions.
  const createdMs = Date.parse(row.desktop_token_created_at);
  if (Number.isNaN(createdMs) || Date.now() - createdMs > TOKEN_MAX_AGE_MS) {
    return { error: unauthorized('Token expired — please reconnect Instagram') };
  }

  return { ig_user_id: row.ig_user_id };
}

function unauthorized(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function serverError(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
