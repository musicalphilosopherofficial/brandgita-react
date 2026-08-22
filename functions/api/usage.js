/**
 * POST /api/usage — usage telemetry ingest.
 *
 * Answers "how much is the app being used, and where" — the conversion signal.
 * Spec: decisions/usage-telemetry-conversion-signal.md in the BrandGita monorepo.
 *
 * PRIVACY CONTRACT, enforced here and not merely promised upstream: this endpoint stores
 * no content of any kind. The event name is checked against a closed enum, and `props` is
 * reduced to a per-event key allowlist before it is stored. The client applies the same
 * allowlist; doing it again here is the point — a desktop build is a thing an attacker
 * controls, so the server must not trust that a filename or transcript fragment was
 * already stripped.
 *
 * Unauthenticated by necessity: the desktop app holds a licence, not a session, and the
 * whole value of the denominator (`app_activated`) is counting people who have not
 * converted. It is rate-limited instead, and every stored field is validated to a short
 * safe charset — this data renders in the admin dashboard, so a stored-XSS payload here
 * would execute there.
 */

import { requireRateLimit, clientKey } from './_ratelimit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// The value ladder. Anything outside this set is refused — mirrors EVENTS in
// brand_gita_core/telemetry/usage.py, and the two must not drift.
const ALLOWED_PROPS = {
  app_activated: new Set(),
  onboarding_completed: new Set(['blocks_done']),
  pipeline_started: new Set(['gita']),
  render_completed: new Set(['gita', 'dur_bucket']),
  render_abandoned: new Set(['gita', 'last_phase']),
  published: new Set(['platform', 'content_type']),
  publish_failed: new Set(['platform', 'content_type']),
  feature_used: new Set(['feature']),
  // Hardware profile — absorbed from the retired FastAPI /v1/hardware endpoint
  // (2026-08-22) so there is one telemetry pipeline rather than a separate server whose
  // only justification was keeping an Airtable key out of the desktop binary. Every
  // value is BUCKETED client-side ("Apple Silicon M3", "32GB") and re-coerced to a short
  // safe scalar here; `encoders` arrives as a joined string ("videotoolbox+qsv") because
  // this allowlist drops arrays.
  hardware_profile: new Set(['cpu_family', 'gpu_family', 'ram_band', 'encoders', 'encode_bucket']),
};

const MAX_PROPS_BYTES = 256;
const SAFE_SCALAR = /^[A-Za-z0-9 ._+-]{0,40}$/;
const LICENSE_HASH = /^[0-9a-f]{64}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * Reduce `props` to the allowlisted keys for `event`, with every value coerced to a short
 * safe scalar. Returns a JSON string, or null when nothing survives.
 */
export function cleanProps(event, props) {
  const allowed = ALLOWED_PROPS[event];
  if (!allowed || !props || typeof props !== 'object' || Array.isArray(props)) return null;

  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (!allowed.has(k)) continue; // drop silently — defence in depth, not an error
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.trunc(v);
    } else if (typeof v === 'string' && SAFE_SCALAR.test(v)) {
      out[k] = v;
    }
    // anything else (object, array, long or unsafe string) is dropped
  }
  if (Object.keys(out).length === 0) return null;

  const s = JSON.stringify(out);
  // Size cap AFTER the allowlist, so a caller cannot pad an allowed key into a payload.
  return new TextEncoder().encode(s).length > MAX_PROPS_BYTES ? null : s;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Unauthenticated + writes to D1, so the limiter is the control. Fails open if the
  // binding is absent — see _ratelimit.js.
  const limited = await requireRateLimit(env, 'USAGE_LIMITER', clientKey(request, 'usage'), CORS);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { license_hash, event, props, app_version, os } = body || {};

  if (!LICENSE_HASH.test(String(license_hash || ''))) {
    // Shape-checked rather than merely non-empty: the client sends a SHA-256 hex digest,
    // so anything else is either a bug or someone sending a raw licence — which must
    // never be stored.
    return json({ ok: false, error: 'Invalid license_hash' }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_PROPS, event)) {
    return json({ ok: false, error: 'Unknown event' }, 400);
  }

  const cleanVersion = SAFE_SCALAR.test(String(app_version || '')) ? String(app_version || '') : '';
  const cleanOs = ['mac', 'win', 'linux'].includes(os) ? os : '';

  try {
    await env.DB.prepare(
      `INSERT INTO usage_events (license_hash, event, props, app_version, os)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(license_hash, event, cleanProps(event, props), cleanVersion, cleanOs).run();
  } catch (err) {
    console.error('D1 usage error:', { message: err?.message });
    // Best-effort, exactly as track.js: telemetry must never block the app.
    return json({ ok: false });
  }

  return json({ ok: true });
}
