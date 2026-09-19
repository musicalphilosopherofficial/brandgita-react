import { mediaSlug, requireUserAuth } from './_auth.js';
import { validateDevice } from './_whop.js';
import { decryptToken } from './_crypto.js';

// Instagram Graph host — matches token.js's /me call version.
const GRAPH_BASE = 'https://graph.instagram.com/v22.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// The Whop entitlement verdict — a FIELD on the response this endpoint already returns,
// never a gate on the endpoint itself. The desktop already polls this as a publish
// pre-flight; folding the verdict in here means it learns "your subscription lapsed" the
// same way it learns "your token expired", instead of a second endpoint the client has to
// separately poll and reconcile against network failures.
//
// One query (a LEFT JOIN, not a missing-row branch to duplicate) answers three cases at
// once: no ig_tokens row, an ig_tokens row with no whop_membership_id, and a genuinely
// linked membership.
async function getEntitlement(env, ig_user_id) {
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT wm.status AS membership_status
         FROM ig_tokens it
         LEFT JOIN whop_memberships wm ON wm.membership_id = it.whop_membership_id
        WHERE it.ig_user_id = ?`
    ).bind(ig_user_id).first();
  } catch (err) {
    console.error('D1 select error (entitlement):', { message: err?.message });
    // Fail open — the same posture as the device check and the Meta probe below. This is
    // an informational field on an already-permissive endpoint, not a new enforcement
    // gate: cron-worker/poster.js's ENTITLED_SQL is what actually stops a lapsed member's
    // posts from publishing, and it re-checks Whop status independently of this value.
    return { entitled: true, entitlement_reason: 'check_failed' };
  }

  // No ig_tokens row (never connected), or a row whose whop_membership_id is null (a
  // connection made before Whop billing existed). Nothing to check entitlement against.
  if (!row || row.membership_status == null) {
    return { entitled: true, entitlement_reason: 'unlinked' };
  }

  // 'active' is the only status migrations/0009's CHECK allows that is NOT "after
  // membership.deactivated". Whop does not fire deactivated for a trial, a completed
  // one-time plan, or a card in its retry grace — those all remain 'active' here until the
  // grace genuinely runs out — so this one comparison already implements "entitled =
  // active/trialing/completed/past_due, not entitled = canceled/expired" without this
  // table needing Whop's finer-grained status vocabulary.
  if (row.membership_status === 'active') {
    return { entitled: true, entitlement_reason: 'active' };
  }

  return {
    entitled: false,
    entitlement_reason: 'membership_lapsed',
    entitlement_message: 'Your Brand Gita subscription has ended. Reconnect after resubscribing to resume publishing.',
  };
}

// GET /api/connection — "is my stored IG token still publish-valid?"
//
// The desktop calls this before firing the first scheduled post so a creator hits
// a clear "reconnect Instagram" prompt at their keyboard instead of discovering a
// dead token hours later when the cron worker silently marks a post TOKEN_EXPIRED.
//
// It probes /{ig_user_id}/content_publishing_limit — that endpoint needs BOTH a
// live token AND the content-publish permission, so a 200 proves the token can
// actually publish, not merely that it authenticates. Read-only: touches no rows.
//
// Returns 200 with a status object for every *connection* state (connected or not,
// publishable or not). Reserves { ok:false } + non-200 for real server faults
// (DB/decrypt), so the desktop can branch on `publishable` without parsing errors.
//
// Also always carries the Whop entitlement verdict: `entitled` (true/false), plus
// `entitlement_reason` (a machine slug: 'active' | 'membership_lapsed' | 'unlinked' |
// 'check_failed') and, only when not entitled, a human `entitlement_message`. This is
// deliberately a FIELD, not a gate — the endpoint never 402s a lapsed member, because a
// hard-gated endpoint can't tell the desktop "your subscription lapsed" apart from
// "the network is down". See getEntitlement() below for what counts as entitled.
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const auth = await requireUserAuth(request, env);
  if (auth.error) return auth.error;
  const { ig_user_id } = auth;

  // Computed once, up front, so every branch below — device_moved, not_connected,
  // token_invalid, check_failed, and the success path — carries the same verdict.
  const entitlement = await getEntitlement(env, ig_user_id);

  // DEVICE RE-VALIDATION — the enforcement point for a licence that has moved machines.
  //
  // The device lock is otherwise checked ONCE, at connect. Clearing a licence's hwid and
  // rebinding it to Machine B never touches Machine A's desktop_token, so Machine A would
  // keep publishing indefinitely — it holds a valid token and, before this, had no reason
  // to ever re-check. (Cancellation is already handled: the membership.deactivated webhook
  // nulls the token server-side, so those calls 401 on their own. It is specifically the
  // device SWAP that had no enforcement.)
  //
  // This endpoint is the right place because the desktop ALREADY calls it as a publish
  // pre-flight — turning an existing call into the enforcement point costs nothing, where
  // a dedicated heartbeat loop would add a request per install per interval forever.
  //
  // OPTIONAL, deliberately. An older desktop build that sends no device_hash still gets a
  // working connection check rather than a hard failure: this is a pre-flight whose job is
  // "can I publish", and bricking older installs over a header they cannot know about is
  // a worse outcome than a slightly later catch. Those builds are still gated at connect,
  // and /api/token hard-REQUIRES device_hash — so a stale build can keep publishing on an
  // already-bound machine, but can never bind a new one.
  const deviceHash = request.headers.get('x-device-hash');
  if (deviceHash) {
    let licenceRow;
    try {
      licenceRow = await env.DB.prepare(
        `SELECT whop_license_key FROM ig_tokens WHERE ig_user_id = ?`
      ).bind(ig_user_id).first();
    } catch (err) {
      console.error('D1 select error (device check):', { message: err?.message });
      licenceRow = null; // fall through — see below
    }

    // Only enforce when we actually know which licence this install belongs to. A row
    // predating the Whop work has no whop_license_key, and refusing those would lock out
    // an existing creator over a column that did not exist when they connected.
    if (licenceRow?.whop_license_key) {
      const check = await validateDevice(licenceRow.whop_license_key, deviceHash, env);
      if (!check.ok && check.status === 409) {
        // 409 specifically — the licence is bound to a DIFFERENT machine. Any other
        // failure (Whop unreachable, missing scope) must NOT lock a paying creator out of
        // their own app: this is a convenience re-check, and the authoritative gate is
        // still /api/token at connect.
        return json(
          { ok: true, connected: false, publishable: false, reason: 'device_moved', ...entitlement },
          200,
        );
      }
    }
  }

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT access_token, token_expiry FROM ig_tokens WHERE ig_user_id = ?`
    )
      .bind(ig_user_id)
      .first();
  } catch (err) {
    console.error('D1 select error (connection):', { message: err?.message });
    return json({ ok: false, error: 'Could not look up connection' }, 500);
  }

  // No token stored — the account was never connected, or the desktop token was
  // revoked. Not an error; a legitimate "reconnect" answer.
  if (!row || !row.access_token) {
    return json({ ok: true, connected: false, publishable: false, reason: 'not_connected', ...entitlement });
  }

  const expires_at = row.token_expiry ?? null;

  let accessToken;
  try {
    accessToken = await decryptToken(row.access_token, env);
  } catch (err) {
    console.error('Token decrypt failed (connection):', { message: err?.message });
    return json({ ok: false, error: 'Could not read stored token' }, 500);
  }

  // Live probe. content_publishing_limit fails with Meta code 190 on an
  // expired/invalid token and with a permission error if the publish scope was
  // never granted or was revoked in the creator's Meta settings.
  let data;
  try {
    const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(ig_user_id)}/content_publishing_limit`);
    url.searchParams.set('fields', 'quota_usage,config');
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString());
    data = await res.json();

    if (!res.ok || data?.error) {
      // Scalar-only log — never serialize `data` (can echo the token back in some errors).
      const code = data?.error?.code;
      console.error('IG content_publishing_limit non-OK:', { status: res.status, code });
      const reason = code === 190 ? 'token_invalid' : 'permission';
      return json({ ok: true, connected: true, publishable: false, reason, expires_at, ...entitlement });
    }
  } catch (err) {
    // Couldn't reach Meta — the token may be fine; report the check itself failed
    // so the desktop can retry rather than telling the creator to reconnect.
    console.error('IG content_publishing_limit network error:', { message: err?.message });
    return json({ ok: true, connected: true, publishable: null, reason: 'check_failed', expires_at, ...entitlement });
  }

  // Publish-valid. Surface the rolling 24h quota so the desktop can warn before a
  // large batch trips Meta's 50-posts/day ceiling.
  const bucket = Array.isArray(data.data) ? data.data[0] : undefined;
  const quota_usage = bucket?.quota_usage ?? null;
  const quota_total = bucket?.config?.quota_total ?? null;

  // media_slug is returned here as well as at connect, so a desktop holding a STALE slug
  // self-heals on its next connection check instead of failing uploads.
  //
  // Without this the slug is issued exactly once, at /api/token, and cached in the
  // desktop cred store forever. Any re-key — rotating MEDIA_SLUG_SECRET, or a future
  // media-slug:v2 — would leave every installed app PUTting to a prefix the server no
  // longer derives, so uploads 403 with no obvious cause and the only cure is
  // disconnect-and-reconnect. Re-deriving it on a call the desktop already makes turns
  // that from an outage into a no-op.
  //
  // Best-effort: this endpoint's job is to answer "can I publish right now". If the slug
  // cannot be derived (no secret configured) that is worth knowing, but it must not turn
  // a working connection check into a 500 — the desktop would report the creator's
  // account as broken because of an unrelated server misconfiguration.
  let media_slug = null;
  try {
    media_slug = await mediaSlug(env, auth.ig_user_id);
  } catch (err) {
    console.error('media slug derivation failed:', { message: err?.message });
  }

  return json({
    ok: true,
    connected: true,
    publishable: true,
    expires_at,
    quota_usage,
    quota_total,
    media_slug,
    ...entitlement,
  });
}
