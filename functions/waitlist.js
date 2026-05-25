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

// Priority score for founding creator invite order
// Higher = invite sooner
function priorityScore({ role, platform, monetise, hardware }) {
  let score = 0;
  if (role === 'coach' || role === 'educator') score += 3;
  else if (role === 'entrepreneur') score += 2;

  if (platform === 'both') score += 3;
  else if (platform === 'youtube' || platform === 'instagram') score += 2;
  else if (platform === 'starting') score += 1;

  if (monetise === 'courses' || monetise === 'coaching') score += 3;
  else if (monetise === 'community') score += 2;
  else if (monetise === 'building') score += 1;

  if (hardware === 'mac-apple-silicon' || hardware === 'windows-intel-nvidia' || hardware === 'windows-amd-nvidia') score += 3;
  else if (hardware === 'windows-intel-qsv') score += 2;

  return score; // max 12
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

  const { email, name, hardware, role, platform, monetise, ai } = body;

  if (!name || !name.trim()) {
    return json({ error: 'First name is required' }, 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, 400);
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanName = name.trim();
  const score = priorityScore({ role, platform, monetise, hardware });

  try {
    // Check if this email already exists — always update with most recent entry
    const existing = await env.DB.prepare(
      `SELECT id FROM waitlist WHERE email = ?`
    ).bind(cleanEmail).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE waitlist SET name=?, hardware=?, role=?, platform=?, monetise=?, ai=?, priority_score=? WHERE id=?`
      ).bind(cleanName, hardware || null, role || null, platform || null, monetise || null, ai || null, score, existing.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO waitlist (email, name, hardware, role, platform, monetise, ai, priority_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(cleanEmail, cleanName, hardware || null, role || null, platform || null, monetise || null, ai || null, score).run();
    }
  } catch (err) {
    console.error('D1 error:', err);
    return json({ error: 'Could not save. Please try again.' }, 500);
  }

  return json({ success: true });
}
