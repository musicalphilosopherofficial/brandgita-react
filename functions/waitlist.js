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

async function sendConfirmationEmail(env, { email, name, token }) {
  if (!env.RESEND_API_KEY) return; // no-op until key is configured

  const confirmUrl = `https://brandgita.com/confirm?token=${token}`;
  const firstName = name ? name.split(' ')[0] : 'there';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Brand Gita <apply@brandgita.com>',
      to: email,
      subject: 'Confirm your application — Brand Gita founding creators',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 2rem 1rem; color: #1A1A18; background: #FDFCF9;">
          <p style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem;">Hey ${firstName},</p>
          <p style="font-size: 0.9375rem; line-height: 1.6; color: #4A4842; margin-top: 0.5rem;">
            Thanks for applying for founding creator access to Brand Gita.
          </p>
          <p style="font-size: 0.9375rem; line-height: 1.6; color: #4A4842;">
            One step left — confirm your email so we know where to reach you when applications open.
          </p>
          <a href="${confirmUrl}" style="display: inline-block; margin-top: 1rem; padding: 0.875rem 2rem; background: #2196F3; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 0.9375rem;">
            Confirm my application →
          </a>
          <p style="font-size: 0.8rem; color: #7A6F63; margin-top: 2rem; line-height: 1.5;">
            If you didn't apply, ignore this email — nothing will happen.<br>
            This link expires in 7 days.
          </p>
        </div>
      `,
    }),
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

  const token = crypto.randomUUID();
  const score = priorityScore({ role, platform, monetise, hardware });

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (email, name, hardware, role, platform, monetise, confirm_token, priority_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        email.toLowerCase().trim(),
        name ? name.trim() : null,
        hardware || null,
        role || null,
        platform || null,
        monetise || null,
        token,
        score
      )
      .run();
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return json({ success: true }); // already signed up — no info leak
    }
    console.error('D1 insert error:', err);
    return json({ error: 'Could not save. Please try again.' }, 500);
  }

  // Fire confirmation email — non-blocking, failure doesn't affect signup
  context.waitUntil(
    sendConfirmationEmail(env, { email: email.toLowerCase().trim(), name, token })
  );

  return json({ success: true });
}
