import { requireUserAuth } from './_auth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  // Per-user bearer auth — resolves to the authenticated ig_user_id
  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

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

  // Enforce key prefix scoping — every key must start with {ig_user_id}/
  // so users can only upload to their own prefix in R2.
  const prefix = `${ig_user_id}/`;
  for (const key of keys) {
    if (!String(key).startsWith(prefix)) {
      return json({ ok: false, error: `All keys must start with your user prefix: ${prefix}` }, 403);
    }
  }

  const origin = new URL(request.url).origin;

  const uploads = keys.map((key) => ({
    key,
    upload_url: `${origin}/api/media/${encodeURIComponent(key)}`,
  }));

  return json({ ok: true, uploads });
}
