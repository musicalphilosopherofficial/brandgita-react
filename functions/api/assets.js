import { requireUserAuth } from './_auth.js';
import { listAssets } from '../../shared/assets.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

/**
 * GET /api/assets?tag=&piece=&aspect=&target=&limit=  → { ok, assets: [...] }
 * What the account has stored and still can use: uploaded, not purged, inside the bucket's expiry.
 * Each asset: { key, piece, targets, aspect, tags, source_path_hash, created_at, uploaded_at, expires_at }.
 * `target` accepts any platform alias (tiktok, ig, youtube) and matches the canonical id.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;

  const q = new URL(request.url).searchParams;
  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return json({ ok: false, error: 'limit must be a positive integer' }, 400);
  }
  try {
    const assets = await listAssets(env, auth.ig_user_id, {
      tag: q.get('tag') || undefined,
      piece: q.get('piece') || undefined,
      aspect: q.get('aspect') || undefined,
      target: q.get('target') || undefined,
      limit,
    });
    return json({ ok: true, assets });
  } catch (err) {
    console.error('D1 select error (assets):', { message: err?.message });
    return json({ ok: false, error: 'Could not list assets' }, 500);
  }
}
