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

  if (request.headers.get('x-api-secret') !== env.API_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { keys } = body;

  if (!Array.isArray(keys) || keys.length === 0) {
    return json({ ok: false, error: 'keys must be a non-empty array' }, 400);
  }

  // Build upload URLs pointing at the /api/media/[key] PUT endpoint on this same worker.
  // The desktop app PUTs files directly to these URLs with x-api-secret in the header.
  const baseUrl = new URL(request.url);
  const origin = baseUrl.origin;

  const uploads = keys.map((key) => ({
    key,
    upload_url: `${origin}/api/media/${encodeURIComponent(key)}`,
  }));

  return json({ ok: true, uploads });
}
