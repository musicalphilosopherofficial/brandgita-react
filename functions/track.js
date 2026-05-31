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

  const { session_id, step, value } = body;

  if (!session_id || !step) {
    return json({ error: 'session_id and step are required' }, 400);
  }

  // This endpoint is unauthenticated. Without validation, an attacker could store
  // arbitrary payloads (e.g. HTML/JS) that later render in the admin dashboard
  // (stored XSS). Allowlist the step, and constrain value to a short safe charset.
  const ALLOWED_STEPS = new Set(['region', 'role', 'platform', 'monetise', 'os', 'mac', 'windows', 'ram', 'ai', 'submitted']);
  if (!ALLOWED_STEPS.has(step)) {
    return json({ ok: false }, 400);
  }
  const cleanValue =
    value == null ? null
    : (typeof value === 'string' && value.length <= 40 && /^[A-Za-z0-9 ._@+-]*$/.test(value) ? value : null);
  const cleanSession = String(session_id).slice(0, 64);

  try {
    await env.DB.prepare(
      `INSERT INTO funnel_events (session_id, step, value) VALUES (?, ?, ?)`
    ).bind(cleanSession, step, cleanValue).run();
  } catch (err) {
    console.error('D1 track error:', err);
    // Never block the user — tracking is best-effort
    return json({ ok: false });
  }

  return json({ ok: true });
}
