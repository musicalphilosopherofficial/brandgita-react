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
