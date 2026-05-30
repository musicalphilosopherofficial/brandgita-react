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

  try {
    await env.DB.prepare(
      `INSERT INTO funnel_events (session_id, step, value) VALUES (?, ?, ?)`
    ).bind(session_id, step, value || null).run();
  } catch (err) {
    console.error('D1 track error:', err);
    // Never block the user — tracking is best-effort
    return json({ ok: false });
  }

  return json({ ok: true });
}
