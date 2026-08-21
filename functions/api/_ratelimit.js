/**
 * Rate limiting for Pages Functions, built on Cloudflare's native binding.
 *
 * ⚠️ FAIL-OPEN, DELIBERATELY. If the binding is absent this returns null (no limit)
 * rather than throwing. That is the right trade for THIS endpoint and worth stating
 * plainly, because fail-open is usually the wrong default:
 *
 *   - Pages Functions support for `[[ratelimits]]` is undocumented. If Pages silently
 *     ignores the binding, `env.X.limit()` is a TypeError on undefined — which would
 *     turn every call into a 500 and stop EVERY creator from connecting. A limiter that
 *     causes a total outage is worse than the abuse it prevents.
 *   - The endpoint is already authenticated. The limiter is defence in depth against
 *     brute force, not the access control itself.
 *
 * So: when it works, it limits; when the platform ignores it, the endpoint behaves
 * exactly as it does today. `rateLimitStatus()` exists so the absence is observable
 * instead of assumed — never conclude the limiter is live without checking it.
 */

/**
 * @returns {Promise<Response|null>} a 429 to return immediately, or null to proceed.
 */
export async function requireRateLimit(env, bindingName, key, corsHeaders = {}) {
  const limiter = env?.[bindingName];
  if (!limiter || typeof limiter.limit !== 'function') return null;

  let success;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch (err) {
    // A limiter that errors must not take the endpoint down with it.
    console.error('Rate limiter error:', { binding: bindingName, message: err?.message });
    return null;
  }
  if (success) return null;

  return new Response(JSON.stringify({ ok: false, error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      // period is fixed at 60s in wrangler.toml; tell the client rather than make it guess.
      'Retry-After': '60',
      ...corsHeaders,
    },
  });
}

/** Whether the binding is actually present. Use to verify, never to assume. */
export function rateLimitStatus(env, bindingName) {
  const limiter = env?.[bindingName];
  return {
    binding: bindingName,
    present: Boolean(limiter && typeof limiter.limit === 'function'),
  };
}

/**
 * The limiter key. Prefer the caller's IP; fall back to a constant so that a request
 * without CF-Connecting-IP is still counted rather than silently exempt — an attacker
 * must not be able to opt out of the limit by stripping a header.
 */
export function clientKey(request, scope) {
  return `${scope}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
}
