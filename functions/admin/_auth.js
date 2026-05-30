/**
 * Basic Auth helper for /admin/* routes.
 * Username: admin   Password: value of EXPORT_SECRET env var
 * Browser saves credentials after first login — no URL token needed.
 */
export function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || ''
  if (authHeader.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice(6))
    const [, pass] = decoded.split(/:(.+)/)  // split on first colon only
    if (pass === env.EXPORT_SECRET) return null  // authorised
  }
  return new Response('Unauthorised', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Brand Gita Admin"' },
  })
}
