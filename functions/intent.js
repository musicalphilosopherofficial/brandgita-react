const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Signals the checkout can report. The current flow sends 'fastlane_claim'; the
// older decoy-payment method ids are kept for backward compatibility.
const VALID_METHODS = new Set([
  'fastlane_claim', 'card', 'paypal', 'apple_pay', 'google_pay',
]);

/**
 * POST /intent  { email, method, token }
 *
 * Records that an applicant claimed their free fast-lane founding spot inside the
 * window, and bumps their priority_score by 100 (once) so high-intent leads sort
 * to the top of the admin export.
 *
 * Anti-forgery: the bump only applies when `token` matches the single-use
 * intent_token that /waitlist issued to this exact applicant on a successful
 * submit. The token is nulled on use, so it can't be replayed and an outsider
 * who only knows someone's email can't inflate (or sabotage) the ranking.
 */
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, method, token } = body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, 400);
  }
  if (!method || !VALID_METHODS.has(method)) {
    return json({ error: 'Invalid signal' }, 400);
  }
  if (!token) {
    return json({ error: 'Missing token' }, 400);
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    // Bump only when the single-use token matches this applicant's stored token,
    // and only on the first signal. Nulling intent_token in the same statement
    // makes the token single-use (no replay). SQLite evaluates all right-hand
    // sides against the pre-update row, so the CASE reads the old intent_signal.
    const res = await env.DB.prepare(
      `UPDATE waitlist
          SET intent_signal = ?,
              intent_at = datetime('now'),
              priority_score = priority_score + (CASE WHEN intent_signal IS NULL THEN 100 ELSE 0 END),
              intent_token = NULL
        WHERE email = ? AND intent_token = ?`
    ).bind(method, cleanEmail, token).run();

    // No row updated → token didn't match (forged, replayed, or stale). Report
    // cleanly rather than erroring; the client UI doesn't depend on the result.
    if (res.meta && res.meta.changes === 0) {
      return json({ success: true, recorded: false });
    }
  } catch (err) {
    console.error('D1 intent error:', { message: err?.message });
    return json({ error: 'Could not record signal' }, 500);
  }

  return json({ success: true, recorded: true });
}
