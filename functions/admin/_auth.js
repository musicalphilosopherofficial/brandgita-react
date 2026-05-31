/**
 * Basic Auth helper for /admin/* routes.
 * Username: admin   Password: value of EXPORT_SECRET env var
 * Browser saves credentials after first login — no URL token needed.
 */

// Constant-time string comparison — avoids leaking the secret via response timing.
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function requireAuth(request, env) {
  // Fail closed if the secret is unset/empty — never authorise against a blank value.
  if (!env.EXPORT_SECRET) return unauthorized();

  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(authHeader.slice(6));
    } catch {
      return unauthorized();
    }
    const [, pass] = decoded.split(/:(.+)/); // split on first colon only
    if (pass && safeEqual(pass, env.EXPORT_SECRET)) return null; // authorised
  }
  return unauthorized();
}

function unauthorized() {
  return new Response('Unauthorised', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Brand Gita Admin"' },
  });
}
