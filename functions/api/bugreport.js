/**
 * POST /api/bugreport — accept an in-app bug report, complaint, or feature request.
 *
 * Step 1 of the build order from the pre-build security review: TEXT ONLY. No media,
 * no recording, no voice. That ordering is deliberate — text plus allowlisted
 * diagnostics is most of the value at a fraction of the risk, and every media path
 * carries a launch blocker that has to be closed first (private bucket with an
 * authenticated GET, preview-before-send, window-scoped capture).
 *
 * WHAT THIS ENDPOINT DELIBERATELY DOES NOT DO
 * -------------------------------------------
 * It does not call Notion or GitHub. It writes a row and returns. A cron worker drains
 * the queue and creates the tracker objects.
 *
 * Two reasons, both load-bearing:
 *   1. A burst would otherwise fan out synchronously into third-party quota. Notion's
 *      API is ~3 req/s, so an inline call hands a stranger synchronous control over
 *      our quota and our bill.
 *   2. The Notion and GitHub tokens must never be reachable from a request path the
 *      public can drive at will.
 *
 * AUTH — why the licence and not the bearer token
 * -----------------------------------------------
 * upload-url.js and friends use requireUserAuth, which resolves an ig_user_id. That is
 * wrong here: the single most valuable bug report is "the app broke during onboarding",
 * and that creator has no connected Instagram account and therefore no bearer token.
 * The Whop licence key exists before IG connect, so it is the identity that covers the
 * whole lifecycle.
 *
 * RATE LIMITING — why a D1 counter and not a binding
 * --------------------------------------------------
 * Cloudflare Pages rejects the [[ratelimits]] binding outright (verified against
 * production, see _ratelimit.js), and the free plan's single WAF rule is already spent
 * on token-bootstrap-bruteforce. A per-licence counter in D1 is what is actually
 * available — and it is the better control anyway, because it is per-identity rather
 * than per-IP and so survives IP rotation.
 *
 * Unlike _ratelimit.js, this quota FAILS CLOSED. That module fails open on purpose:
 * blocking a creator's publish is worse than a missing limit. Here the downstream cost
 * is a third-party bill and a polluted tracker, so an unreadable counter must reject.
 *
 * MEDIA — A REFERENCE, NEVER CONTENT
 * ----------------------------------
 * `diagnostics.media_key` may name a recording already stored by POST
 * /api/bugreport/media. The bytes never come through here; see that file for why one
 * combined request was rejected. Two things are still checked before the key is stored:
 * its SHAPE, and that it sits under THIS membership's slug — otherwise a creator could
 * cite someone else's key in their own report and read it back through
 * GET /api/bugreport/media/{key}, which authorises against the reporting licence.
 */

import { checkWhopLicense } from './_whop.js';
import { bugMediaSlug, isCoherentMediaKey, MEDIA_PREFIX } from './bugreport/_media.js';

/** The diagnostics fields that may carry an attachment reference, and the kind each one
 *  must name. Kept as data so the check below is one loop rather than three branches
 *  that could drift apart. Mirrored in electron-shell/bugreport.js's ALLOWED_FIELDS. */
const MEDIA_REF_KIND = {
  media_key: 'recording',
  screenshot_key: 'screenshot',
  voice_key: 'voice',
};
const MEDIA_REF_FIELDS = Object.keys(MEDIA_REF_KIND);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const REPORT_TYPES = new Set(['bug', 'complaint', 'feature_request']);
const MAX_TEXT = 4000;
const DAILY_QUOTA = 5;

/**
 * Server-side credential scan.
 *
 * The Electron client scrubs before sending (electron-shell/scrub.js), but the client
 * is the part an attacker controls, and a denylist is one missed pattern from useless.
 * This is the gate that actually holds. Kept intentionally close to the client corpus
 * so the two can be compared.
 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gsk_[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /xai-[A-Za-z0-9_-]{16,}/,
  /EAA[A-Za-z0-9]{20,}/,
  /IGQ[A-Za-z0-9_-]{20,}/,
  /ya29\.[A-Za-z0-9_-]{20,}/,
  /\b1\/\/[A-Za-z0-9_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}/,
  /Bearer\s+[A-Za-z0-9\-._~+/]{10,}/i,
  /(?:api[_-]?key|apikey|secret|password|authorization)\s*[:=]\s*\S{8,}/i,
];

function containsSecret(value) {
  if (value == null) return false;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return SECRET_PATTERNS.some((re) => re.test(s));
}

function reportId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return 'bg-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { license_key, report_type, summary, transcript_raw, diagnostics } = body || {};

  // ── shape validation, before any I/O ──────────────────────────────────────
  if (!license_key || typeof license_key !== 'string') {
    return json({ ok: false, error: 'license_key is required' }, 400);
  }
  if (!REPORT_TYPES.has(report_type)) {
    return json(
      { ok: false, error: `report_type must be one of: ${[...REPORT_TYPES].join(', ')}` },
      400,
    );
  }

  const text = String(summary ?? '').trim();
  const raw = String(transcript_raw ?? '').trim();
  // A voice note is an ALTERNATIVE to typing, not a garnish on it (founder, 2026-09-01).
  // A creator who is mid-bug and frustrated should be able to say what happened instead
  // of composing a paragraph, so a report carrying audio is not empty even with no text.
  // The reference is validated properly below; this is only asking "is there anything to
  // act on at all", so a truthy check is the right strength here.
  const hasVoice = Boolean(diagnostics && typeof diagnostics === 'object' && diagnostics.voice_key);
  if (!text && !raw && !hasVoice) {
    return json({ ok: false, error: 'Report is empty — nothing to act on' }, 400);
  }
  if (text.length > MAX_TEXT || raw.length > MAX_TEXT) {
    return json({ ok: false, error: `Text exceeds ${MAX_TEXT} characters` }, 413);
  }

  // ── credential scan, before persistence and before the licence round trip ──
  // Cheap, and refusing early means a leaked key never touches storage at all.
  if (containsSecret(text) || containsSecret(raw) || containsSecret(diagnostics)) {
    return json(
      {
        ok: false,
        error:
          'This report appears to contain a credential (an API key, token or password). ' +
          'Please remove it and try again.',
      },
      422,
    );
  }

  // ── entitlement: fails closed ─────────────────────────────────────────────
  // __checkWhopLicense is a seam for tests only; production always takes the import.
  const check = env.__checkWhopLicense || checkWhopLicense;
  const licence = await check(license_key, env);
  if (!licence.ok) {
    return json({ ok: false, error: licence.error || 'Licence check failed' }, licence.status || 403);
  }

  // ── per-licence daily quota: also fails closed ────────────────────────────
  const membership = licence.membershipId || 'unknown';
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bug_reports
        WHERE membership_id = ? AND created_at > datetime('now', '-1 day')`,
    )
      .bind(membership)
      .first();
    if ((row?.n ?? 0) >= DAILY_QUOTA) {
      return json(
        { ok: false, error: `Daily limit of ${DAILY_QUOTA} reports reached. Try again tomorrow.` },
        429,
      );
    }
  } catch (err) {
    console.error('bugreport: quota check failed', { message: err?.message });
    return json({ ok: false, error: 'Could not verify report quota' }, 503);
  }

  // ── attachments: validate each REFERENCE, and that it is theirs ───────────
  // One loop over all three fields, not three copies of the check. A fourth attachment
  // kind should mean adding a name to MEDIA_REF_FIELDS, never adding another branch that
  // could be written slightly differently from these.
  const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
  const attached = MEDIA_REF_FIELDS.map((f) => [f, diag[f]]).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );

  if (attached.length) {
    let slug;
    try {
      slug = await bugMediaSlug(env, membership);
    } catch (err) {
      console.error('bugreport: media slug derivation failed', { message: err?.message });
      return json({ ok: false, error: 'Could not verify the attached media' }, 503);
    }
    for (const [field, value] of attached) {
      if (!isCoherentMediaKey(value)) {
        return json({ ok: false, error: `${field} is not a valid attachment reference` }, 400);
      }
      if (!value.startsWith(`${MEDIA_PREFIX}${slug}/`)) {
        // Citing another creator's key would make GET /api/bugreport/media/{key} hand it
        // over, because that route authorises against the licence presenting the key. The
        // report is where that must be caught: the reference is only ever legitimate if
        // the licence filing the report is the one that uploaded the media.
        return json({ ok: false, error: 'That attachment was not uploaded by this licence' }, 403);
      }
      // A key whose KIND does not match the field it arrived in is a client bug at best
      // and a mislabelled preview at worst — the creator would have watched one thing
      // and sent another. Cheap to check, and the check has to live somewhere.
      if (value.split('/')[2] !== MEDIA_REF_KIND[field]) {
        return json({ ok: false, error: `${field} does not reference a ${MEDIA_REF_KIND[field]}` }, 400);
      }
    }
  }

  // ── persist for the cron drain ────────────────────────────────────────────
  const id = reportId();

  // The creator's words land verbatim in a GitHub issue body. This repo runs `claude -p`
  // delegation and cloud Claude sessions, so an issue body is untrusted input to any
  // future automated triage. Mark it as data at rest so every downstream reader — human
  // or model — sees the boundary rather than having to infer it.
  const payload = JSON.stringify({
    untrusted_user_input: { summary: text, transcript_raw: raw },
    diagnostics: diagnostics ?? {},
  });

  try {
    await env.DB.prepare(
      `INSERT INTO bug_reports (report_id, membership_id, report_type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
    )
      .bind(id, membership, report_type, payload)
      .run();
  } catch (err) {
    // External-I/O failure path must log (scripts/check_diagnostic_logging.py).
    console.error('bugreport: insert failed', { message: err?.message });
    return json({ ok: false, error: 'Could not save report' }, 503);
  }

  // Return the opaque id ONLY. A Notion URL or GitHub issue number would leak internal
  // tracker structure and invite enumeration; the id is what the creator quotes to
  // support, and what a future "my reports" view keys on.
  return json({ ok: true, report_id: id });
}
