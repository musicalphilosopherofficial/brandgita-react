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

// Decoy payment methods the checkout can report. Anything else is rejected.
const VALID_METHODS = new Set(['card', 'paypal', 'apple_pay', 'google_pay']);

/**
 * POST /intent  { email, method }
 *
 * Records a "reached for the wallet" demand signal for an existing waitlist
 * applicant. No payment is taken and no card data is ever collected — the
 * checkout buttons are decoys (see src/components/Checkout.jsx). The first
 * time an applicant signals intent, their priority_score is bumped by 100 so
 * high-intent leads sort to the top of the admin export.
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

  const { email, method } = body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, 400);
  }

  if (!method || !VALID_METHODS.has(method)) {
    return json({ error: 'Invalid payment method' }, 400);
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    // Bump priority only on the FIRST signal — re-clicks update the method and
    // timestamp but don't keep inflating the score. SQLite evaluates all
    // right-hand sides against the pre-update row, so the CASE reads the old
    // intent_signal correctly.
    const res = await env.DB.prepare(
      `UPDATE waitlist
          SET intent_signal = ?,
              intent_at = datetime('now'),
              priority_score = priority_score + (CASE WHEN intent_signal IS NULL THEN 100 ELSE 0 END)
        WHERE email = ?`
    ).bind(method, cleanEmail).run();

    // No matching row — applicant somehow reached checkout without a waitlist
    // record. Nothing to flag; report cleanly rather than erroring.
    if (res.meta && res.meta.changes === 0) {
      return json({ success: true, recorded: false });
    }
  } catch (err) {
    console.error('D1 intent error:', err);
    return json({ error: 'Could not record signal' }, 500);
  }

  return json({ success: true, recorded: true });
}
