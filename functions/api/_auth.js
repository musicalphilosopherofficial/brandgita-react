/**
 * Per-user bearer token auth for desktop → cloud API calls.
 *
 * Usage in an endpoint:
 *   const auth = await requireUserAuth(request, env)
 *   if (auth.error) return auth.error          // 401 Response
 *   const { ig_user_id } = auth                // scoped to this user
 *
 * The desktop sends:  Authorization: Bearer <desktop_token>
 * Token is minted in POST /api/token after OAuth, stored in ig_tokens.desktop_token.
 * A token identifies exactly one ig_user_id — so every endpoint is automatically
 * scoped: users can only touch their own rows and R2 objects.
 */
export async function requireUserAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) {
    return { error: unauthorized('Missing or invalid Authorization header') }
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: unauthorized('Empty bearer token') }
  }

  let row
  try {
    row = await env.DB.prepare(
      `SELECT ig_user_id FROM ig_tokens WHERE desktop_token = ?`
    ).bind(token).first()
  } catch (err) {
    console.error('Auth token lookup failed:', err)
    return { error: serverError('Auth lookup failed') }
  }

  if (!row) {
    return { error: unauthorized('Invalid or expired token') }
  }

  return { ig_user_id: row.ig_user_id }
}

function unauthorized(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function serverError(message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
