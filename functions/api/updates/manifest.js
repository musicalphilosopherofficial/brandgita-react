/**
 * GET /api/updates/manifest — what the newest shipped desktop build is.
 *
 * WHY THIS DID NOT EXIST
 * ----------------------
 * brand_gita_core/updates/manifest.py has fetched this endpoint since it was written, and
 * the endpoint was never built. It returned HTTP 200 the whole time — but that 200 was the
 * SPA catch-all serving index.html, so the client got a page of HTML where it expected
 * JSON, failed to parse, and swallowed the error by design (a failed update check must
 * never block launch). The result: every update check in the product's history has
 * silently failed, and no creator has ever been told an update exists.
 *
 * That is the same shape as the two other silent-failure bugs found on 2026-08-22 — a
 * default pointing somewhere that does not resolve, plus an except that hides it.
 *
 * SHAPE — matches what manifest.py actually reads, field for field:
 *   version                 semver of the newest build
 *   rollout_stage_percent   0-100; the client samples itself and stays quiet if outside
 *   notes_url               what changed, for the creator
 *   bundle_sha256           set once builds are signed (C16); null until then
 *   signature               same
 *   bundled_models          model name -> version, for the verifier
 *
 * The client decides whether the update APPLIES (semver compare, rollout sampling). This
 * endpoint only states what exists — keeping the comparison client-side means a creator
 * on an old build gets the same answer whatever we deploy.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * The current release. Deliberately a literal rather than a D1 lookup: it changes once
 * per release, a database round trip would add a failure mode to a path whose whole job
 * is to be quiet and reliable, and a wrong value here is caught by the client's own
 * semver comparison rather than shipping anyone a bad download.
 *
 * ROLLOUT is 0 until there is a signed build to point at. At 0 the client computes
 * available=false for everyone, so this endpoint is honest — it says "nothing newer for
 * you" rather than announcing an update that cannot be installed. Raise it when C16
 * signing lands and a real artifact exists.
 */
const RELEASE = {
  version: '0.1.0',
  rollout_stage_percent: 0,
  notes_url: 'https://brandgita.com/changelog',
  bundle_sha256: null,
  signature: null,
  bundled_models: {},
};

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  return new Response(JSON.stringify(RELEASE), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Short cache: an update check runs at most once per launch, and a stale manifest
      // delays a rollout for everyone behind the edge.
      'Cache-Control': 'public, max-age=300',
      ...CORS,
    },
  });
}
