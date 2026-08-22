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
  // paid-recurring can each report a different string) and is not safe to gate on.
  if (data?.valid !== true) {
    return { ok: false, status: 402, error: 'Membership is not active' };
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

/**
 * Clear a licence's device binding — `PATCH /memberships/{id}` with `{"metadata": {}}`.
 *
 * Confirmed live 2026-08-22 against a real membership, full cycle: reset -> rebind to a
 * NEW device (201) -> re-lock enforced against a THIRD device (400). Uses the SAME
 * `member:manage` permission already enabled for `validate_license` — no new scope.
 *
 * DELIBERATELY NOT WIRED to any endpoint yet. This is the mechanism a support flow needs
 * ("creator got a new laptop, let them back in"), but WHO is allowed to call it is a real
 * decision this module should not make unilaterally — it must be gated behind the
 * creator's own authenticated identity (so a customer can only reset THEIR OWN licence,
 * never someone else's) before it is reachable from any endpoint. See the founder for
 * where that flow should live (self-serve in the desktop app vs. a support action).
 */
export async function resetDeviceLock(membershipId, env) {
  if (!env.WHOP_COMPANY_API) {
    return { ok: false, status: 503, error: 'License checking not configured' };
  }

  let res;
  try {
    res = await fetch(`${WHOP_API_BASE}/memberships/${encodeURIComponent(membershipId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.WHOP_COMPANY_API}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ metadata: {} }),
    });
  } catch (err) {
    console.error('Whop device-lock reset failed (network):', { message: err?.message });
    return { ok: false, status: 502, error: 'Could not reach Whop' };
  }

  if (!res.ok) {
    console.error('Whop device-lock reset non-OK:', { status: res.status });
    return { ok: false, status: 502, error: 'Reset failed' };
  }
  return { ok: true };
}
