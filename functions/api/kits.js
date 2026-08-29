/**
 * /api/kits — a creator's brand IP, kept so they cannot lose it.
 *
 * WHY (founder, 2026-08-30): *"the intellectual property aesthetic and vision should be in
 * cloudflare."* Only that. A kit on disk is ~430 KB; the irreplaceable part is ~32 KB of text —
 * vision-gita.md, aesthetic-gita.md, brand-spec.json. Lose those and the creator has lost the
 * interview that produced them.
 *
 * DELIBERATELY NOT HERE: fonts (licensed third-party binaries, and 320 KB of that 430 KB —
 * storing them would make us a redistributor of someone else's typeface), and tokens.css /
 * index.html, which are DERIVED from brand-spec.json and are regenerated rather than synced,
 * because a synced derivative eventually disagrees with its source.
 *
 * THIS IS NOT A READ-THROUGH CACHE. The desktop gallery must open instantly and offline, so
 * ~/.bg/brand-gitas holds a complete working copy and this is the source of truth it syncs
 * with — on launch, and after an edit.
 *
 * AUTH IS THE WHOP LICENCE, per the founder's call. Ownership is keyed on the MEMBERSHIP id
 * rather than the licence key: it is stable per customer, it is not the secret the creator
 * types (so a leaked row is not a leaked credential), and it survives a licence reset, which a
 * device hash would not.
 */

import { checkWhopLicense } from './_whop.js';
import { requireRateLimit, clientKey } from './_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Per-kit ceiling. The three files are ~32 KB; 512 KB is generous and still bounded. */
export const MAX_KIT_BYTES = 512 * 1024;

/** The only fields that sync. Anything else a client sends is dropped, not stored. */
export const SYNCED_FIELDS = Object.freeze(['vision_gita', 'aesthetic_gita', 'brand_spec']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * Is this a slug we will store? Directory-name shaped, and nothing else.
 *
 * The slug becomes a directory name on the creator's disk when it syncs down, so a value
 * containing `/` or `..` is a path-traversal waiting to happen on the OTHER side of the wire.
 * Refusing it here is cheaper than trusting every future client to sanitise it.
 */
export function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

/**
 * The storable subset of a client payload, or an error.
 *
 * Default-deny: a field not in SYNCED_FIELDS is dropped rather than stored, so a client that
 * starts sending `fonts` or a whole `tokens_css` cannot quietly turn this into the asset store
 * it is explicitly not.
 */
export function sanitiseKit(body) {
  if (!body || typeof body !== 'object') return { error: 'a kit body is required' };

  const out = {};
  let bytes = 0;
  for (const field of SYNCED_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== 'string') return { error: `${field} must be text` };
    bytes += value.length;
    out[field] = value;
  }

  if (bytes === 0) return { error: 'a kit must contain at least one file' };
  if (bytes > MAX_KIT_BYTES) {
    // Named rather than truncated. A silently trimmed aesthetic-gita would sync back down and
    // overwrite the creator's full copy with the shortened one — a data-loss bug wearing a
    // success response.
    return { error: `kit is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_KIT_BYTES / 1024} KB` };
  }

  // brand_spec is JSON on the client and JSON on the way back. Rejecting malformed JSON here
  // means a corrupt spec cannot be stored and then fail on every future sync down.
  if (out.brand_spec !== null) {
    try {
      JSON.parse(out.brand_spec);
    } catch {
      return { error: 'brand_spec must be valid JSON' };
    }
  }

  return { kit: out };
}

/** The licence key from an Authorization: Bearer header, or ''. */
function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : '';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const limited = await requireRateLimit(env, 'KITS_LIMITER', clientKey(request, 'kits'), CORS);
  if (limited) return limited;

  const licenseKey = bearer(request);
  if (!licenseKey) return json({ ok: false, error: 'a licence key is required' }, 401);

  const licence = await checkWhopLicense(licenseKey, env);
  if (!licence.ok) return json({ ok: false, error: licence.error }, licence.status);
  const member = licence.membershipId;

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';

  // ── GET — every kit this customer owns ─────────────────────────────────────
  if (request.method === 'GET') {
    try {
      const rows = await env.DB.prepare(
        `SELECT slug, vision_gita, aesthetic_gita, brand_spec, updated_at
           FROM brand_kits WHERE membership_id = ? ORDER BY updated_at DESC`
      ).bind(member).all();
      return json({ ok: true, kits: rows.results || [] });
    } catch (err) {
      console.error('D1 read error (brand_kits):', { message: err?.message });
      return json({ ok: false, error: 'Could not read your brand kits' }, 500);
    }
  }

  if (!isValidSlug(slug)) {
    return json({ ok: false, error: 'slug must be lowercase letters, digits and hyphens' }, 400);
  }

  // ── PUT — save one kit ─────────────────────────────────────────────────────
  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { kit, error } = sanitiseKit(body);
    if (error) return json({ ok: false, error }, 400);

    // The SERVER stamps the time. A client clock is not evidence of anything, and a wrong one
    // would silently reorder which copy of a kit looks newest.
    const updatedAt = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO brand_kits (membership_id, slug, vision_gita, aesthetic_gita, brand_spec, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(membership_id, slug) DO UPDATE SET
           vision_gita = excluded.vision_gita,
           aesthetic_gita = excluded.aesthetic_gita,
           brand_spec = excluded.brand_spec,
           updated_at = excluded.updated_at`
      ).bind(member, slug, kit.vision_gita, kit.aesthetic_gita, kit.brand_spec, updatedAt).run();
    } catch (err) {
      console.error('D1 write error (brand_kits):', { message: err?.message });
      return json({ ok: false, error: 'Could not save your brand kit' }, 500);
    }
    return json({ ok: true, slug, updated_at: updatedAt });
  }

  // ── DELETE — remove one kit ────────────────────────────────────────────────
  if (request.method === 'DELETE') {
    try {
      await env.DB.prepare(
        `DELETE FROM brand_kits WHERE membership_id = ? AND slug = ?`
      ).bind(member, slug).run();
    } catch (err) {
      console.error('D1 delete error (brand_kits):', { message: err?.message });
      return json({ ok: false, error: 'Could not delete your brand kit' }, 500);
    }
    return json({ ok: true, slug, deleted: true });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
