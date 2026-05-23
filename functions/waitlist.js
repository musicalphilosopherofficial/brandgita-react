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

  const { email, name, hardware, role, platform, monetise } = body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, 400);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (email, name, hardware, role, platform, monetise) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        email.toLowerCase().trim(),
        name ? name.trim() : null,
        hardware || null,
        role || null,
        platform || null,
        monetise || null
      )
      .run();
  } catch (err) {
    // UNIQUE constraint → already signed up, treat as success (no info leak)
    if (err.message && err.message.includes('UNIQUE')) {
      return json({ success: true });
    }
    console.error('D1 insert error:', err);
    return json({ error: 'Could not save. Please try again.' }, 500);
  }

  return json({ success: true });
}
