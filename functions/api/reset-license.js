/**
 * POST /api/reset-license — "I got a new machine" self-serve device-lock reset.
 *
 * Gated the SAME way /api/token is: x-api-secret (proves it's our real app) + the
 * customer's own licence key. Not a bearer-token/session gate, deliberately — by
 * definition this is called from a machine that has never connected before, so there is
 * no existing session to require. Holding the licence key IS the proof of ownership,
 * exactly like connecting for the first time.
 *
 * All the actual logic — entitlement check via `valid`, the 30-day cooldown, metadata
 * preservation — lives in resetDeviceLock() (_whop.js). This file is just the route:
 * method, rate limit, auth, response shape.
 */
import { resetDeviceLock } from './_whop.js';
import { requireRateLimit, clientKey } from './_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  // Same reasoning as /api/token: slow down guessing BEFORE the secret check, so a wrong
  // guess costs the attacker a token from their bucket, not just the check after it.
  const limited = await requireRateLimit(env, 'TOKEN_LIMITER', clientKey(request, 'reset-license'), CORS);
  if (limited) return limited;

  if (request.headers.get('x-api-secret') !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { license_key } = body;
  if (!license_key || typeof license_key !== 'string') {
    return json({ ok: false, error: 'license_key is required' }, 400);
  }

  const result = await resetDeviceLock(license_key, env);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, result.status);
  }
  return json({ ok: true });
}
