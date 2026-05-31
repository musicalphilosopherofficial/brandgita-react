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
  // Role: 'creator' is the only accepted role ('none' is rejected upstream).
  if (role === 'creator') score += 3;

  // Platform: both > youtube. ('instagram'-only is rejected upstream.)
  if (platform === 'both') score += 3;
  else if (platform === 'youtube') score += 2;

  // Monetisation: already earning ranks above still-building.
  if (monetise === 'monetising') score += 3;
  else if (monetise === 'building') score += 1;

  // Hardware: dedicated GPU paths rank above Quick Sync.
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

  const { email, name, hardware, region, role, platform, monetise, ram, ai } = body;

  if (!name || !name.trim()) {
    return json({ error: 'First name is required' }, 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email is required' }, 400);
  }

  // Server-side geo gate — EEA/UK/Switzerland are not served (see privacy policy).
  // Defence in depth: the form blocks this client-side, but never trust the client.
  if (region === 'uk-eu-swiss') {
    return json({ error: 'Brand Gita is not currently available in your region.' }, 403);
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
        `UPDATE waitlist SET name=?, hardware=?, region=?, role=?, platform=?, monetise=?, ram=?, ai=?, priority_score=? WHERE id=?`
      ).bind(cleanName, hardware || null, region || null, role || null, platform || null, monetise || null, ram || null, ai || null, score, existing.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO waitlist (email, name, hardware, region, role, platform, monetise, ram, ai, priority_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(cleanEmail, cleanName, hardware || null, region || null, role || null, platform || null, monetise || null, ram || null, ai || null, score).run();
    }
  } catch (err) {
    console.error('D1 error:', err);
    return json({ error: 'Could not save. Please try again.' }, 500);
  }

  return json({ success: true });
}
