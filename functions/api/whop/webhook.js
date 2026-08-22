/**
 * POST /api/whop/webhook — receives Whop's membership.activated / membership.deactivated
 * events and mirrors membership state into `whop_memberships`.
 *
 * THIS ENDPOINT DOES NOT YET GATE ANYTHING. /api/token still checks the shared API_SECRET
 * (decisions/public-endpoint-hardening.md §3 names that as un-replaced). This is the
 * receiver + storage half only — wiring /api/token to check whop_memberships instead is a
 * separate change, blocked on the desktop app having a way to identify which Whop
 * customer it belongs to. Building this now because Whop needs a live URL to set up the
 * webhook against, and a URL that 404s fails their setup check.
 *
 * SIGNATURE VERIFICATION — Whop follows the Standard Webhooks spec
 * (https://www.standardwebhooks.com/): three headers, `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`. The signed message is `{webhook-id}.{webhook-timestamp}.{raw body}`,
 * HMAC-SHA256'd with the webhook secret Whop shows ONCE at webhook-creation time (format
 * `whsec_<base64>` per the Standard Webhooks convention — the `whsec_` prefix is stripped
 * and the remainder base64-decoded to get the raw key bytes). `webhook-signature` carries
 * the result as `v1,<base64>` — comparison is constant-time.
 *
 * ⚠️ NOT YET CONFIRMED AGAINST A REAL WHOP WEBHOOK. Built from Whop's own docs
 * (docs.whop.com/developer/guides/webhooks) and the Standard Webhooks spec they say they
 * follow, but no live event has hit this code yet. The first real test send from Whop's
 * dashboard is the actual verification — if it 401s, capture the raw headers and body and
 * fix the mismatch here rather than assume the endpoint or the secret is wrong.
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

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Raw HMAC key bytes from Whop's `whsec_<base64>` secret format. */
async function importSigningKey(secret) {
  const withoutPrefix = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = base64ToBytes(withoutPrefix);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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

  return json({ ok: true });
}
