/**
 * Rate limiting for Pages Functions, built on Cloudflare's native binding.
 *
 * ⚠️ ON PAGES THIS IS CURRENTLY A NO-OP. Measured 2026-08-21 against production:
 * twelve unauthenticated POSTs to /api/token returned twelve 401s and no 429. Wrangler
 * also rejects the config outright — "Configuration file for Pages projects does not
 * support ratelimits". The binding is a Workers feature; Pages does not take it.
 *
 * Local evidence said the opposite, which is the lesson worth keeping: `wrangler pages
 * dev` DOES wire the binding and DOES return 429 after 10 requests. Local dev is more
 * permissive than the platform, so a limiter proven to work locally proves nothing about
 * production. Only the live burst settled it.
 *
 * Actual rate limiting for Pages is a WAF Rate Limiting Rule in the dashboard (free plan:
 * one rule). This module stays because it is correct, costs nothing while inert, and
 * becomes live the moment the endpoint moves to a real Worker.
 *
 * ⚠️ FAIL-OPEN, DELIBERATELY — and that is the only reason the above was not an outage.
 * If the binding is absent this returns null (no limit) rather than throwing:
 *
 *   - Had it failed closed, `env.X.limit()` on undefined would be a TypeError, turning
 *     every /api/token call into a 500 and stopping EVERY creator from connecting. That
 *     is exactly the situation Pages put us in, silently, on the first deploy.
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
