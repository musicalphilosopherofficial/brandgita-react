/**
 * Whop membership entitlement check — the replacement for trusting the shared API_SECRET
 * alone. A licence key proves WHICH customer is connecting, not just "some copy of our
 * app is calling us."
 *
 * This checks "is this licence key an active membership" — confirmed working with
 * `member:basic:read` + `member:email:read`, the permissions already on WHOP_COMPANY_API.
 *
 * Device-locking (one key, one machine at a time) is a SEPARATE call —
 * `POST /memberships/{id}/validate_license` — needing an ADDITIONAL permission
 * (`member:manage`), because it writes to the membership's metadata rather than only
 * reading it. See `validateDevice()` below.
 *
 * Base URL and auth confirmed live 2026-08-22 against a bogus id: the API returned a
 * well-formed 404 body ("No such Membership found..."), not a 401/403 — proving both the
 * URL and the key's permissions are correct, not just assumed from docs.
 */

const WHOP_API_BASE = 'https://api.whop.com/api/v2';

// The metadata-clearing PATCH is a DIFFERENT API version from everything else in this
// file. v2's PATCH /memberships/{id} needs `membership:update`, a permission that stayed
// 401 despite being reported enabled twice. v1's PATCH /memberships/{id} does the exact
// same thing — accepts the mem_ id or license key, same {"metadata": {...}} body — but
// only needs member:manage/member:basic:read/member:email:read, the three permissions
// already confirmed working via validate_license. Confirmed live 2026-08-22: v1 PATCH
// returned 200 and cleared metadata on the real membership, with the SAME key that 401'd
// on v2. GET (checkWhopLicense) and POST .../validate_license (validateDevice) stay on
// v2 — only this one write moves. v1's response SHAPE also differs completely (user_id
// not user, no `valid` field, top-level fields instead of nested) — irrelevant here since
// this call only needs the PATCH to succeed, not to parse its response body.

/**
 * @returns {Promise<{ok: true, membershipId: string, whopUserId: string, email: string|null}
 *                  | {ok: false, status: number, error: string}>}
 */
export async function checkWhopLicense(licenseKey, env) {
  if (!env.WHOP_COMPANY_API) {
    console.error('checkWhopLicense called but WHOP_COMPANY_API is not configured');
    return { ok: false, status: 503, error: 'License checking not configured' };
  }
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { ok: false, status: 400, error: 'license_key is required' };
  }

  let res;
  try {
    res = await fetch(`${WHOP_API_BASE}/memberships/${encodeURIComponent(licenseKey)}`, {
      headers: { Authorization: `Bearer ${env.WHOP_COMPANY_API}` },
    });
  } catch (err) {
    console.error('Whop membership lookup failed (network):', { message: err?.message });
    // Fails CLOSED, unlike the rate limiter elsewhere in this codebase — an unreachable
    // Whop must not be treated as "membership valid". A real customer retries; a bypass
    // here would let ANYONE in for as long as Whop happens to be unreachable.
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }

  if (res.status === 404) {
    return { ok: false, status: 402, error: 'License key not found' };
  }
  if (!res.ok) {
    console.error('Whop membership lookup non-OK:', { status: res.status });
    return { ok: false, status: 502, error: 'License check failed' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: 502, error: 'Malformed response from Whop' };
  }

  // `valid`, NOT `status`. Confirmed against a REAL membership 2026-08-22: a free-trial
  // membership on this account returns status:"completed" (not "active") while
  // valid:true — so checking status==='active' would have REJECTED a legitimate,
  // currently-entitled customer. `valid` is the field Whop documents as the actual
  // access signal; status vocabulary varies by plan/payment type (trial, free,
  // paid-recurring can each report a different string), and can plausibly diverge from
  // real access during a cancel_at_period_end grace window — so it is never the gate,
  // only used below for a friendlier message once we already know the answer is "no".
  if (data?.valid !== true) {
    const label = typeof data?.status === 'string' ? ` (${data.status})` : '';
    return { ok: false, status: 402, error: `Membership is not active${label}` };
  }

  // `user` is a BARE STRING (the user id) on this endpoint, not a nested {id, email}
  // object — and `email` is a TOP-LEVEL field. Confirmed against a real membership
  // 2026-08-22 after this exact mismatch took the live endpoint down with a false
  // "Malformed membership" 502: the webhook payload (functions/api/whop/webhook.js) DOES
  // carry a nested user object with email inside it, and that shape was wrongly assumed
  // here too. Two different Whop surfaces, two different shapes for "user" — do not
  // assume they match just because both come from Whop.
  if (!data.id || !data.user) {
    console.error('Whop membership missing expected fields', { hasId: !!data.id, hasUser: !!data.user });
    return { ok: false, status: 502, error: 'Malformed membership from Whop' };
  }

  return {
    ok: true,
    membershipId: data.id,
    whopUserId: data.user,
    email: typeof data.email === 'string' ? data.email.slice(0, 320) : null,
    // Needed by resetDeviceLock's cooldown logic (last_reset_at lives here) and PATCH's
    // fetch-merge-preserve requirement — PATCH replaces the WHOLE metadata object, so any
    // caller that wants to clear one key must first read the others to keep them.
    metadata: (data.metadata && typeof data.metadata === 'object') ? data.metadata : {},
    // NAME COLLISION, worth knowing before touching this: on the FAILURE branch above,
    // `status` is an HTTP status code (402, 503, ...). On THIS success branch, `status`
    // is Whop's own status STRING ("active", "completed", ...) — a different type,
    // same key name. Never a live bug today because every real caller checks `.ok`
    // before reading `.status`, but do not read `.status` off this object without
    // checking `.ok` first.
    //
    // Whop's own status vocabulary, for a SPECIFIC error message only — never for the
    // pass/fail decision above, which stays on `valid`. See resetDeviceLock's docstring
    // for why: status can plausibly diverge from actual access during a
    // cancel_at_period_end grace window, and `valid` is the field proven correct against
    // a real account (2026-08-22), not assumed from a status list.
    status: typeof data.status === 'string' ? data.status : null,
  };
}

/**
 * Device-lock a licence to one machine at a time — `POST /memberships/{id}/validate_license`.
 *
 * `deviceHash` must ALREADY be a one-way hash computed on the desktop from a stable local
 * machine identifier — never the raw identifier. Whop stores whatever we send as opaque
 * metadata; sending a raw hardware ID would mean a third party (Whop) holds a real
 * device fingerprint of the creator's machine for no functional benefit over a hash.
 *
 * Sent under the key `hwid` — Whop's own documented/example field name for this exact
 * purpose, not an invented one. This matters more than it looks: the field name is part
 * of what gets compared for equality, so a homegrown key name can never match anything
 * already bound under Whop's own convention (or whatever a support flow / dashboard tool
 * might read or write). Confirmed the hard way 2026-08-22 — an earlier version of this
 * function used `device_hash` and every call against a real, already-bound membership
 * came back as a mismatch, even calls with the identical value, because the KEY differed
 * from what was already stored.
 *
 * Response contract (confirmed against Whop's docs, NOT yet exercised against a real
 * membership — no customer has connected a second device yet to prove the 400 path):
 *   201 — valid. Either first use (metadata was empty, now bound to `deviceHash`), or a
 *         later call from the SAME device (metadata already matches).
 *   400 — the licence is bound to a DIFFERENT device's hash already.
 *   401 — the API key lacks `member:manage`. Treated the same as "reach failure" here —
 *         a misconfigured permission must not silently grant unlimited-device access.
 *
 * Needs `member:manage` on WHOP_COMPANY_API, confirmed via Whop's own docs 2026-08-22 —
 * DISTINCT from `member:basic:read`/`member:email:read`, which only cover the read-only
 * lookup in `checkWhopLicense` above. Without it this fails closed (502), same posture
 * as every other "couldn't verify" path in this module.
 */
export async function validateDevice(membershipId, deviceHash, env) {
  if (!env.WHOP_COMPANY_API) {
    return { ok: false, status: 503, error: 'License checking not configured' };
  }
  if (!deviceHash || typeof deviceHash !== 'string') {
    return { ok: false, status: 400, error: 'device_hash is required' };
  }

  let res;
  try {
    res = await fetch(
      `${WHOP_API_BASE}/memberships/${encodeURIComponent(membershipId)}/validate_license`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHOP_COMPANY_API}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ metadata: { hwid: deviceHash } }),
      },
    );
  } catch (err) {
    console.error('Whop validate_license failed (network):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }

  if (res.status === 201) {
    return { ok: true };
  }
  if (res.status === 400) {
    return { ok: false, status: 409, error: 'This license is already active on another device' };
  }
  if (res.status === 401) {
    console.error(
      'Whop validate_license 401 — WHOP_COMPANY_API is missing the member:manage permission',
    );
    return { ok: false, status: 502, error: 'Device check not permitted (missing API scope)' };
  }
  console.error('Whop validate_license unexpected status:', { status: res.status });
  return { ok: false, status: 502, error: 'Device check failed' };
}

// A customer resetting on demand, with no cooldown, is a way to share one seat across a
// team — reset, use on machine A, reset again, use on machine B, repeat indefinitely.
// Whop does not rate-limit this itself, so this module does.
const RESET_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Clear a licence's device binding for the "I got a new machine" flow.
 *
 * Two systems, two jobs, deliberately not one:
 *   - WHOP owns the device binding (`hwid` in its membership metadata) — cleared via
 *     `PATCH /api/v1/memberships/{id}` with `{"metadata": {}}`.
 *   - WE own the cooldown timer (`whop_license_resets` in D1) — because that same PATCH
 *     is confirmed live (2026-08-22) to be ALL-OR-NOTHING: an empty metadata object wipes
 *     everything, a non-empty one MERGES and cannot delete one key while keeping another.
 *     There is no way to clear `hwid` while preserving a `last_reset_at` marker inside
 *     the same Whop object, so the cooldown cannot live there. An earlier version of this
 *     function tried exactly that and silently failed to ever clear `hwid` at all.
 *
 * The v1/v2 split is real and deliberate, not a typo: v2's PATCH needs `membership:update`
 * (never confirmed working despite being reported enabled twice); v1's PATCH does the
 * identical operation with `member:manage`/`member:basic:read`/`member:email:read` — the
 * three permissions already confirmed working via `validate_license`. GET (checkWhopLicense)
 * and POST .../validate_license (validateDevice) stay on v2, which is unaffected by any
 * of this and already proven correct.
 */
export async function resetDeviceLock(licenseKey, env) {
  const licenseCheck = await checkWhopLicense(licenseKey, env);
  if (!licenseCheck.ok) {
    return licenseCheck;
  }
  if (!env.DB) {
    console.error('resetDeviceLock called without a DB binding — cannot enforce cooldown');
    return { ok: false, status: 503, error: 'Reset not available' };
  }

  let cooldownRow;
  try {
    cooldownRow = await env.DB.prepare(
      `SELECT last_reset_at FROM whop_license_resets WHERE membership_id = ?`
    ).bind(licenseCheck.membershipId).first();
  } catch (err) {
    console.error('D1 read failed (whop_license_resets):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not check reset cooldown' };
  }

  if (cooldownRow?.last_reset_at) {
    const elapsedMs = Date.now() - new Date(cooldownRow.last_reset_at).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < RESET_COOLDOWN_MS) {
      const daysLeft = Math.ceil((RESET_COOLDOWN_MS - elapsedMs) / (24 * 60 * 60 * 1000));
      return {
        ok: false,
        status: 429,
        error: `A license can only be reset once every 30 days. Try again in ${daysLeft} day(s).`,
      };
    }
  }

  if (!env.WHOP_COMPANY_API) {
    return { ok: false, status: 503, error: 'License checking not configured' };
  }

  let res;
  try {
    res = await fetch(
      `https://api.whop.com/api/v1/memberships/${encodeURIComponent(licenseCheck.membershipId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.WHOP_COMPANY_API}`,
          'Content-Type': 'application/json',
        },
        // Unconditionally empty — this is the ONLY body shape confirmed to actually clear
        // the binding. We never had another metadata key of our own to preserve here in
        // the first place; `hwid` is the sole key `validate_license` ever writes.
        body: JSON.stringify({ metadata: {} }),
      },
    );
  } catch (err) {
    console.error('Whop device-lock reset failed (network):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }

  if (!res.ok) {
    console.error('Whop device-lock reset non-OK:', { status: res.status });
    return { ok: false, status: 502, error: 'Reset failed' };
  }

  // Stamp the cooldown AFTER Whop confirms the reset, not before — a failed PATCH must
  // not start a 30-day timer for something that never actually happened.
  try {
    await env.DB.prepare(
      `INSERT INTO whop_license_resets (membership_id, last_reset_at) VALUES (?, ?)
       ON CONFLICT(membership_id) DO UPDATE SET last_reset_at = excluded.last_reset_at`
    ).bind(licenseCheck.membershipId, new Date().toISOString()).run();
  } catch (err) {
    // The reset itself already succeeded on Whop's side — do not fail the whole
    // operation over a bookkeeping write. Logged loudly: a missed stamp means the NEXT
    // reset attempt will not be cooldown-blocked, which is a real (if narrow) gap, not
    // nothing.
    console.error('Failed to record reset cooldown (reset itself succeeded):', { message: err?.message });
  }

  return { ok: true };
}
