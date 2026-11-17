/**
 * Whop membership entitlement check — the replacement for trusting the shared API_SECRET
 * alone. A licence key proves WHICH customer is connecting, not just "some copy of our
 * app is calling us."
 *
 * This checks "is this licence key an active membership" via `GET /api/v1/memberships/{key}`
 * (needs `member:basic:read`).
 *
 * Device-locking (one key, one machine at a time) is a SEPARATE step — GET the membership,
 * then `PATCH /memberships/{id}` to write `metadata.hwid` on first use — needing an
 * ADDITIONAL permission (`member:manage`), because it writes to the membership's metadata.
 * See `validateDevice()` below. (Was v2 `POST .../validate_license`; migrated 2026-11-12.)
 *
 * Base URL and auth confirmed live 2026-08-22 against a bogus id: the API returned a
 * well-formed 404 body ("No such Membership found..."), not a 401/403 — proving both the
 * URL and the key's permissions are correct, not just assumed from docs.
 */

// Whop's "Current API" (/api/v1). Everything in this file used to call /api/v2 (GET
// membership, POST .../validate_license); v2 stops working 2026-11-13, so all three calls
// now go to v1, per https://docs.whop.com/developer/api/migrate-from-previous-versions#v2.
const WHOP_API_BASE = 'https://api.whop.com/api/v1';

// Pinned on every request, as the migration guide requires. Without it Whop falls back to
// the key's stored pin or the original 2025-01-01 behaviour, so a future default change
// could silently alter response shapes under us. Value = newest entry in Whop's changelog
// at migration time (2026-11-12); bump deliberately after re-reading the changelog.
const WHOP_API_VERSION_DATE = '2026-11-10-1';

function whopHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.WHOP_COMPANY_API}`,
    'Api-Version-Date': WHOP_API_VERSION_DATE,
    ...extra,
  };
}

// v1 dropped v2's `valid` boolean. Entitlement is now decided from `status`. `completed`
// is included on purpose: a real free-trial membership on this account reported
// status:"completed" (see the regression test) and must still pass. `past_due`,
// `unresolved`, `canceled`, `expired` are all denied (fail closed). A membership that is
// cancelled-at-period-end stays `active` until the period ends, so the grace window is
// preserved.
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'completed']);

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
      headers: whopHeaders(env),
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
  // v1: `valid` no longer exists — decided from `status` (see ENTITLED_STATUSES above).
  if (!ENTITLED_STATUSES.has(data?.status)) {
    const label = typeof data?.status === 'string' ? ` (${data.status})` : '';
    return { ok: false, status: 402, error: `Membership is not active${label}` };
  }

  // v1 renamed v2's bare-string `user` to `user_id`, and has no `email` field at all.
  // (The webhook payload in functions/api/whop/webhook.js is a different surface with its
  // own nested user object — do not assume the two match.)
  if (!data.id || !data.user_id) {
    console.error('Whop membership missing expected fields', { hasId: !!data.id, hasUserId: !!data.user_id });
    return { ok: false, status: 502, error: 'Malformed membership from Whop' };
  }

  return {
    ok: true,
    membershipId: data.id,
    whopUserId: data.user_id,
    // v1 membership objects carry no email. Kept in the result shape (always null) so no
    // caller's destructuring changes; no caller reads it today.
    email: null,
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
 * Device-lock a licence to one machine at a time — GET `/memberships/{id}` then, on first
 * use only, PATCH `metadata.hwid` (replaces v2 `POST .../validate_license`).
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
 * Result contract (the v1 flow is NOT yet exercised against a real membership):
 *   ok     — first use (metadata.hwid was empty, now bound to `deviceHash`), or the stored
 *            hwid already equals `deviceHash`.
 *   409    — the licence is bound to a DIFFERENT device's hash already.
 *   502    — 401/403 (key lacks `member:manage`) or any other failure. Treated as "reach
 *            failure" — a misconfigured permission must not silently grant unlimited-device
 *            access.
 * Not atomic: two first-use calls racing could both bind (v2 validate_license did this in
 * one call). Last write wins; the loser is rejected on its next call.
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

  const url = `${WHOP_API_BASE}/memberships/${encodeURIComponent(membershipId)}`;

  // v1 has no validate_license: read the membership, compare `metadata.hwid`, and write it
  // on first use. Server-side only (never from distributed software), per Whop's guide.
  let getRes;
  try {
    getRes = await fetch(url, { headers: whopHeaders(env) });
  } catch (err) {
    console.error('Whop device check failed (network):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }
  if (getRes.status === 401 || getRes.status === 403) {
    console.error('Whop device check', getRes.status, '— WHOP_COMPANY_API lacks permission for memberships');
    return { ok: false, status: 502, error: 'Device check not permitted (missing API scope)' };
  }
  if (!getRes.ok) {
    console.error('Whop device check lookup non-OK:', { status: getRes.status });
    return { ok: false, status: 502, error: 'Device check failed' };
  }
  let membership;
  try {
    membership = await getRes.json();
  } catch {
    return { ok: false, status: 502, error: 'Device check failed' };
  }

  const bound = membership?.metadata?.hwid;
  if (typeof bound === 'string' && bound) {
    if (bound === deviceHash) return { ok: true };
    return { ok: false, status: 409, error: 'This license is already active on another device' };
  }

  // First use: bind. PATCH merges metadata keys, so any other keys survive.
  let patchRes;
  try {
    patchRes = await fetch(url, {
      method: 'PATCH',
      headers: whopHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ metadata: { hwid: deviceHash } }),
    });
  } catch (err) {
    console.error('Whop device bind failed (network):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }
  if (patchRes.ok) return { ok: true };
  if (patchRes.status === 401 || patchRes.status === 403) {
    console.error('Whop device bind', patchRes.status, '— WHOP_COMPANY_API is missing the member:manage permission');
    return { ok: false, status: 502, error: 'Device check not permitted (missing API scope)' };
  }
  console.error('Whop device bind unexpected status:', { status: patchRes.status });
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
 * All three Whop calls in this file now use v1 (v2 sunsets 2026-11-13). This PATCH was
 * already v1; it needs `member:manage`.
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
      `${WHOP_API_BASE}/memberships/${encodeURIComponent(licenseCheck.membershipId)}`,
      {
        method: 'PATCH',
        headers: whopHeaders(env, { 'Content-Type': 'application/json' }),
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
