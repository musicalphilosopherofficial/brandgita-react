/**
 * POST /api/whop/webhook — receives Whop's membership.activated / membership.deactivated
 * events and mirrors membership state into `whop_memberships`.
 *
 * THIS ENDPOINT DOES NOT YET GATE ANYTHING. /api/token still checks the shared API_SECRET
 * (decisions/public-endpoint-hardening.md §3 names that as un-replaced). This is the
 * receiver + storage half only — wiring /api/token to check whop_memberships instead is a
 * separate change, blocked on the desktop app having a way to identify which Whop
 * customer it belongs to.
 *
 * SIGNATURE VERIFICATION — CONFIRMED against Whop's own docs 2026-08-22, for this
 * account's webhook (api_version v1). Three headers: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`. Signed message: `{webhook-id}.{webhook-timestamp}.{raw body}`,
 * HMAC-SHA256'd, digest base64-encoded. `webhook-signature` carries the result as
 * `v1,<base64>`.
 *
 * KEY HANDLING — the one detail that is easy to get wrong and did get wrong here on the
 * first pass: the `ws_...` secret is used as its RAW ASCII BYTES as the HMAC key. It is
 * NOT base64-encoded and must not be decoded. (Whop's own SDK base64-ENCODES the raw
 * secret before handing it to a generic Standard-Webhooks verifier library that expects a
 * base64-formatted key; that library then decodes it right back — net effect is identical
 * to using the raw bytes directly, which is what a hand-rolled Worker should just do.) The
 * first implementation of this endpoint instead tried to base64-DECODE the secret, which
 * for a real `ws_...` value (contains `_`, not valid base64) either throws or derives the
 * wrong key entirely — every real webhook would have 401'd forever. Caught before any real
 * Whop event hit this code, by asking Whop's own assistant for the exact spec rather than
 * trusting my first pass against the public docs.
 *
 * FAILS CLOSED, unlike the rate limiter elsewhere in this codebase. Accepting a forged
 * membership.activated grants free access; accepting a forged membership.deactivated
 * locks out a paying customer. Both are worse than rejecting a legitimate event and
 * relying on Whop's retry (webhooks retry on non-2xx).
 */

const encoder = new TextEncoder();

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The `ws_...` secret's raw ASCII bytes, used directly as the HMAC key — confirmed via
 * Whop's own docs 2026-08-22. No prefix stripping, no base64 decoding. */
async function importSigningKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Verify a Standard Webhooks-signed request. Returns true/false — never throws, so a
 * malformed header (which an attacker fully controls) cannot turn into a 500 that might
 * leak a stack trace instead of a clean 401.
 */
async function verifySignature(secret, id, timestamp, rawBody, signatureHeader) {
  try {
    // Replay protection — reject anything outside a 5-minute window, per the spec.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const key = await importSigningKey(secret);
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${id}.${timestamp}.${rawBody}`),
    );
    const expected = bytesToBase64(new Uint8Array(mac));

    // webhook-signature may carry multiple space-separated `v1,<sig>` values (key
    // rotation) — accept if ANY of them match.
    return signatureHeader
      .split(' ')
      .map((part) => part.split(',')[1])
      .filter(Boolean)
      .some((candidate) => timingSafeEqual(encoder.encode(candidate), encoder.encode(expected)));
  } catch {
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Fail closed if the secret is not configured — an unverifiable webhook must never be
  // treated as authentic. This is the state until the founder runs:
  //   npx wrangler pages secret put WHOP_WEBHOOK_SECRET
  // with the value Whop shows once at webhook-creation time.
  if (!env.WHOP_WEBHOOK_SECRET) {
    console.error('Whop webhook received but WHOP_WEBHOOK_SECRET is not configured');
    return json({ error: 'Webhook not configured' }, 503);
  }

  const id = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signature = request.headers.get('webhook-signature');
  if (!id || !timestamp || !signature) {
    // Known Whop quirk: a TEST send from the dashboard has been reported to omit
    // webhook-signature entirely. That is Whop's bug, not a reason to accept — a webhook
    // that cannot be verified is not distinguishable from a forged one.
    return json({ error: 'Missing signature headers' }, 401);
  }

  // Read the RAW body once, before any parsing — the signature is over these exact
  // bytes, not over JSON.stringify(JSON.parse(body)), which is not guaranteed identical
  // (key order, whitespace, number formatting).
  const rawBody = await request.text();

  const valid = await verifySignature(env.WHOP_WEBHOOK_SECRET, id, timestamp, rawBody, signature);
  if (!valid) {
    console.error('Whop webhook signature verification failed', { id });
    return json({ error: 'Invalid signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { type, data } = event || {};

  // Unknown or not-yet-handled event types are acknowledged, not rejected. Whop retries on
  // non-2xx, and a type we don't yet act on is not a delivery failure.
  if (type !== 'membership.activated' && type !== 'membership.deactivated') {
    return json({ ok: true, ignored: type });
  }

  const membershipId = data?.id;
  const whopUserId = data?.user?.id;
  if (!membershipId || !whopUserId) {
    console.error('Whop webhook missing required fields', { type, hasId: !!membershipId, hasUser: !!whopUserId });
    return json({ error: 'Missing membership id or user id' }, 400);
  }

  const status = type === 'membership.activated' ? 'active' : 'inactive';
  const email = typeof data?.user?.email === 'string' ? data.user.email.slice(0, 320) : null;
  const planId = typeof data?.plan?.id === 'string' ? data.plan.id : null;
  const productId = typeof data?.product?.id === 'string' ? data.product.id : null;

  try {
    await env.DB.prepare(
      `INSERT INTO whop_memberships (membership_id, whop_user_id, email, status, plan_id, product_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(membership_id) DO UPDATE SET
         whop_user_id = excluded.whop_user_id,
         email        = excluded.email,
         status       = excluded.status,
         plan_id      = excluded.plan_id,
         product_id   = excluded.product_id,
         updated_at   = datetime('now')`
    ).bind(membershipId, whopUserId, email, status, planId, productId).run();
  } catch (err) {
    console.error('D1 whop_memberships upsert failed:', { message: err?.message });
    // 500, not a swallowed {ok:false} — Whop should RETRY a storage failure, unlike the
    // best-effort telemetry endpoints elsewhere in this codebase. Losing a membership
    // state change silently is a billing-correctness bug, not an analytics gap.
    return json({ ok: false, error: 'Storage failed' }, 500);
  }

  // Revoke desktop access the moment a membership deactivates — real-time, not on the
  // creator's next connect attempt. Without this, /api/token's Whop check (functions/
  // api/_whop.js) only runs at CONNECT time, so a cancelled customer keeps a fully
  // working desktop_token indefinitely: recording the cancellation here without acting
  // on it would make this table a historical log, not an access control.
  //
  // Best-effort deliberately: a failure here must not turn a successful membership-state
  // write into a 500 that makes Whop retry the whole webhook, re-running the upsert above
  // for no reason. Logged loudly instead — an un-revoked token is a real problem, but not
  // one Whop retrying the same event will fix.
  if (status === 'inactive') {
    try {
      const result = await env.DB.prepare(
        `UPDATE ig_tokens SET desktop_token = NULL, desktop_token_created_at = NULL
         WHERE whop_membership_id = ?`
      ).bind(membershipId).run();
      if (result?.meta?.changes) {
        console.log('Revoked desktop_token for deactivated Whop membership', { membershipId, changes: result.meta.changes });
      }
    } catch (err) {
      console.error('Failed to revoke desktop_token on membership deactivation:', { membershipId, message: err?.message });
    }
  }

  return json({ ok: true });
}
