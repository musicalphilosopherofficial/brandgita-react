/**
 * _media.js — the shared vocabulary for bug-report media: where an object lives, what a
 * key is allowed to look like, and how a key is bound to the membership that owns it.
 *
 * Three routes depend on agreeing about this, and they must not each carry their own
 * copy of the rules:
 *
 *   POST /api/bugreport/media        mints a key and stores the bytes
 *   GET  /api/bugreport/media/{key}  serves them back, authenticated
 *   POST /api/bugreport              accepts a key as a REFERENCE inside diagnostics
 *
 * WHY A NEW ROUTE INSTEAD OF REUSING /api/media/{key}
 * ---------------------------------------------------
 * `functions/api/media/[key].js` serves GET with NO auth check at all, and that is
 * correct for what it does: Instagram fetches scheduled reels from those URLs without
 * credentials, so authenticating them would break publishing. The consequence, stated
 * plainly in `electron-shell/bugreport.js`, is that a URL on that route is not a
 * reference to a credential — it IS one. Attaching a creator's screen recording there
 * would mean anyone holding the URL can watch it forever.
 *
 * So bug-report media gets its own route with its own auth posture. Same bucket, because
 * the bucket was never the control — the ROUTE is; a bucket is not "public" or "private"
 * in R2, only reachable or not through the code in front of it.
 *
 * THE TWO CONTROLS THAT MAKE SHARING THE BUCKET SAFE
 * --------------------------------------------------
 * 1. A bug-report key is structurally unreachable through the old route. Its KEY_SHAPE
 *    requires `{slug}/{reel|cover|carousel}/{name}.{mp4|mov|jpg|jpeg|png}` — a
 *    `bugreport/…/….webm` key fails on the first segment, the second segment AND the
 *    extension. Pinned by a test in media/key.test.js so a future loosening of that
 *    regex cannot silently expose these objects.
 * 2. The old route additionally REFUSES the `bugreport/` prefix outright, before shape
 *    checking. Belt and braces: control 1 is a property of a regex someone might edit,
 *    control 2 is an explicit statement of intent that reads as a rule.
 *
 * WHY THE MEMBERSHIP IS IN THE KEY
 * --------------------------------
 * `bugreport/{membershipSlug}/{kind}/{YYYYMMDD}-{32 hex}.webm`.
 *
 * The slug is an HMAC of the membership id — the same construction and the same
 * reasoning as `mediaSlug` in ../_auth.js, one secret apart. It buys two things that
 * would otherwise each need a D1 table and a migration:
 *
 *   TENANCY.  GET re-derives the slug from the AUTHENTICATED licence and requires the
 *             key to sit under it. A creator with a perfectly valid licence therefore
 *             cannot read another creator's recording — "authenticated" alone would not
 *             have prevented that, and it is the more likely real-world mistake.
 *   QUOTA.    Today's uploads are countable with one R2 list() against
 *             `bugreport/{slug}/{kind}/{YYYYMMDD}-`, so the daily cap needs no counter
             table — and it is per-kind, so a burst of screenshots cannot exhaust the
             allowance for the recording that actually shows the bug.
 *
 * The slug is not reversible and never needs to be: every call already knows the
 * membership from the licence check.
 *
 * WHAT THE SLUG DOES DISCLOSE, SINCE IT TRAVELS INTO A GITHUB ISSUE
 * -----------------------------------------------------------------
 * The key ends up in a bug report's diagnostics, and from there in an issue body. Two
 * reports from the same creator share a prefix, so the prefix links them. That is not a
 * new disclosure: both reports are already filed against the same membership id in D1,
 * and linking a creator's own reports to each other is the point of having an identity
 * on them at all. It discloses nothing to anyone who could not already correlate them,
 * and it names no person, account or file.
 */

/**
 * THREE KINDS, ONE PIPE
 * ---------------------
 * A screen recording, a screenshot and a voice note are the same trust boundary: creator
 * media, captured in-app, leaving the machine only on an explicit decision. They get one
 * route, one auth model, one quota mechanism and one key shape — not three.
 *
 * The KIND is nonetheless part of the key, for two reasons that are not cosmetic. It
 * lets the client render the right preview without sniffing bytes (a `.webm` is a video
 * or an audio clip depending only on how it was captured), and it makes the quota
 * per-kind, so a burst of screenshots cannot exhaust a creator's ability to attach the
 * recording that actually shows the bug.
 *
 * Content types are an allowlist per kind, never a shared "any media" set: the bucket is
 * served from the apex domain by the sibling public route, so what may be stored here is
 * a security question, not a convenience one.
 */
export const MEDIA_KINDS = {
  recording: {
    types: new Map([['video/webm', 'webm'], ['video/mp4', 'mp4']]),
    // A recording of a bug is a minute or two. Generous for that, still bounded: a valid
    // licence must not be able to stream terabytes into R2 on our bill.
    maxBytes: 120 * 1024 * 1024,
    // Above the 5/day report quota — a creator may reasonably re-record before they are
    // happy with what they captured.
    dailyQuota: 10,
  },
  screenshot: {
    types: new Map([['image/png', 'png'], ['image/jpeg', 'jpg']]),
    // A window screenshot on a 6K display is a few MB as PNG. 25 is headroom, not need.
    maxBytes: 25 * 1024 * 1024,
    // Cheap to take, so cheap to spam; still generous for "here are the four screens it
    // walked through".
    dailyQuota: 20,
  },
  voice: {
    types: new Map([
      ['audio/webm', 'webm'],
      ['audio/ogg', 'ogg'],
      ['audio/mp4', 'm4a'],
    ]),
    // Minutes of speech, not an album. Opus in a webm container runs ~1 MB/minute.
    maxBytes: 30 * 1024 * 1024,
    dailyQuota: 10,
  },
};

export const MEDIA_PREFIX = 'bugreport/';

/**
 * `bugreport/{20 hex}/{kind}/{8 digits}-{32 hex}.{ext}`
 *
 * Fully anchored and fixed-width in every group: there is no unbounded class in front of
 * a fixed-width one, so there is no backtracking trap (the hazard called out on the
 * public route's KEY_SHAPE, where readable slug words made one possible).
 */
export const MEDIA_KEY_SHAPE =
  /^bugreport\/[0-9a-f]{20}\/(recording|screenshot|voice)\/[0-9]{8}-[0-9a-f]{32}\.(webm|mp4|png|jpg|ogg|m4a)$/;

export function isBugMediaKey(key) {
  return typeof key === 'string' && MEDIA_KEY_SHAPE.test(key);
}

/**
 * True when the extension is one the KIND in the same key actually allows.
 *
 * MEDIA_KEY_SHAPE alone would accept `…/voice/….png` — both halves are individually
 * valid. Nothing catastrophic follows from a mislabelled object, but the client picks
 * its preview element from the kind, and a key that lies about itself is a key that
 * renders as a silently-broken <audio> the creator cannot check before sending.
 */
export function isCoherentMediaKey(key) {
  if (!isBugMediaKey(key)) return false;
  const [, , kind, name] = key.split('/');
  const ext = name.split('.').pop();
  return [...MEDIA_KINDS[kind].types.values()].includes(ext);
}

/**
 * HMAC-SHA256(membershipId) truncated to 20 hex chars (80 bits).
 *
 * MEDIA_SLUG_SECRET, falling back to API_SECRET, mirroring ../_auth.js#mediaSlug — but
 * with a DIFFERENT info string mixed in, so a bug-report slug and a public media slug for
 * the same person are unrelated values. Without that, publishing a creator's public media
 * URL would also publish the prefix their private recordings live under.
 *
 * Throws when no secret is configured. Every caller catches and fails CLOSED: an
 * unconfigured secret must reject the request, never fall back to a constant prefix that
 * would put every creator's recordings in one shared, mutually-readable namespace.
 */
export async function bugMediaSlug(env, membershipId) {
  const secret = env.MEDIA_SLUG_SECRET || env.API_SECRET;
  if (!secret) {
    throw new Error('MEDIA_SLUG_SECRET (or API_SECRET) is required to derive a bug-media slug');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`bugreport-media:${membershipId}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

/** UTC, not local: the quota window must not depend on which colo answered. */
export function utcDayStamp(now = new Date()) {
  return (
    String(now.getUTCFullYear()) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0')
  );
}

/** The prefix today's uploads of one kind share — what quota list()s against. */
export function dayPrefix(slug, kind, now = new Date()) {
  return `${MEDIA_PREFIX}${slug}/${kind}/${utcDayStamp(now)}-`;
}

export function mintMediaKey(slug, kind, ext, now = new Date()) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const rand = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${dayPrefix(slug, kind, now)}${rand}.${ext}`;
}
