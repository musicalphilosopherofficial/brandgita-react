// functions/api/study-inbox.js — phone-screenshot study records → the local app's inbox.
//
// Mailbox pattern (see decisions/study-inbox-sync.md): the /study skill POSTs a study-record here;
// the local Electron app polls (GET) and ingests, then acks. The cloud session and the app never
// connect directly. Founder-side tooling — bearer-gated with the STUDY_SECRET env var.
//
// One endpoint, routed by method/body:
//   GET  /api/study-inbox            → pending records (the poller)
//   POST /api/study-inbox {items}    → submit a study-record (the skill)
//   POST /api/study-inbox {ack:[id]} → mark those consumed (the poller, after ingest)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Constant-time compare — avoids leaking the secret via response timing.
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function authed(request, env) {
  if (!env.STUDY_SECRET) return false; // fail closed if the secret is unset
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return false;
  return safeEqual(h.slice(7).trim(), env.STUDY_SECRET);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (!authed(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }

  // GET → poll pending
  if (request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, record FROM study_inbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50"
      ).all();
      const records = (results || []).map((r) => ({ id: r.id, record: JSON.parse(r.record) }));
      return json({ records });
    } catch (err) {
      console.error('study-inbox GET error:', err);
      return json({ records: [] });
    }
  }

  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  // ack: { ack: ["id", ...] } → mark consumed
  if (Array.isArray(body.ack)) {
    try {
      for (const id of body.ack.slice(0, 100)) {
        await env.DB.prepare("UPDATE study_inbox SET status = 'consumed' WHERE id = ?")
          .bind(String(id).slice(0, 64)).run();
      }
      return json({ ok: true, acked: body.ack.length });
    } catch (err) {
      console.error('study-inbox ack error:', err);
      return json({ ok: false });
    }
  }

  // submit: a study-record with items[]
  if (!Array.isArray(body.items)) {
    return json({ error: 'items[] required' }, 400);
  }
  const recordStr = JSON.stringify(body);
  if (recordStr.length > 262144) {
    return json({ error: 'record too large (max 256KB)' }, 413);
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO study_inbox (id, record, status) VALUES (?, ?, 'pending')"
    ).bind(id, recordStr).run();
    return json({ ok: true, id });
  } catch (err) {
    console.error('study-inbox POST error:', err);
    return json({ ok: false }, 500);
  }
}
