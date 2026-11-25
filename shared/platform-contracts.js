/**
 * Platform contracts — the shared VALIDATION vocabulary for scheduled posts.
 *
 * Imported by BOTH deployments: the Pages Functions (`/api/schedule` validates a create
 * request) and the cron Worker (which routes a due post to its adapter). Only the
 * vocabulary is shared — the publish IMPLEMENTATIONS are not, because `schedule.js` never
 * publishes and `poster.js` never validates a create request.
 *
 * A single shared file rather than a synced duplicate, verified empirically before being
 * relied on: `wrangler deploy --dry-run --outdir` from `cron-worker/` was confirmed to
 * bundle an import from `../shared/`, so the `_crypto.js` precedent ("the cron Worker
 * cannot import from functions/") does not apply here. That claim was untested; this one
 * is not.
 *
 * PURE. No fetch, no env, no I/O — so both deployments can import it with no bindings, and
 * it is testable without a Workers runtime.
 *
 * THE PLATFORM ID IS THE DEBUGGING SEAM. The same short string ('ig', 'yt', ...) is the
 * registry key here, the `platform` column in `scheduled_posts`, the adapter key in the
 * cron worker, and the `platform` field on every log line. One id through every layer is
 * what makes "show me every failure for platform X" a filter instead of a cross-reference
 * between vocabularies that happen to mean the same thing.
 */

export const DEFAULT_PLATFORM = 'ig';

// Clients say "tiktok"/"instagram"; the registry, the `platform` column, the adapter key and every log line
// say 'tt'/'ig'. One canonical id through every layer (see the header) — the alias is mapped at the edge.
export { canonicalPlatform } from './media-specs.js';

/** 'image' | 'video' | null from the R2 key's extension. The desktop uploader writes .jpg for an image and .mp4 for a
 *  video (the carousel path already branches on this); Meta's story images are JPEG only. */
export function assetKindOf(key) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key));
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image';
  if (ext === 'mp4') return 'video';
  return null;
}

/**
 * ONE generic validator for every platform's content types. A platform declares a `shapes` table — per content type:
 *   min/max     how many assets          msg        the message when the count is wrong
 *   caption     'required' (default) | 'optional' | 'none'   — 'none' REJECTS a non-empty caption (never silently dropped)
 *   cover       false = a cover_key is rejected
 *   assetKinds  allowed kinds from assetKindOf (['image','video']); omitted = not checked
 *   checkMedia  true = the optional width/height/duration facts are judged against MEDIA_SPECS (judgeFile)
 * Adding Facebook Stories (or any platform's story) is a new `shapes` entry, not new validation code.
 */
function validateShape(contract, { type, asset_keys, caption, cover_key } = {}) {
  const problems = [];
  const shape = contract.shapes[type];
  if (!shape) {
    problems.push(`type must be one of: ${contract.contentTypes.join(', ')}`);
    // Everything below is type-specific; stop rather than emit cascading nonsense about a type that does not exist.
    return problems;
  }
  const n = Array.isArray(asset_keys) ? asset_keys.length : 0;
  if (n < shape.min || n > shape.max) problems.push(shape.msg);
  if (shape.assetKinds && Array.isArray(asset_keys)) {
    for (const k of asset_keys) {
      const kind = assetKindOf(k);
      if (!kind || !shape.assetKinds.includes(kind)) {
        problems.push(`a ${type} asset must be a .jpg image or an .mp4 video (JPEG only for images); got ${JSON.stringify(k)}`);
      }
    }
  }
  const label = contract.label || contract.id;
  if (shape.caption === 'none' && typeof caption === 'string' && caption.length > 0) {
    problems.push(`a ${type} cannot have a caption (${label} ignores it): send an empty caption`);
  }
  if (shape.cover === false && cover_key) {
    problems.push(`a ${type} cannot have a cover_key`);
  }
  if (typeof caption === 'string' && caption.length > contract.captionMax) {
    problems.push(`caption must be ${contract.captionMax} characters or fewer`);
  }
  return problems;
}

/** Is a caption mandatory for this content type on this contract? (Unknown type: true, so the type error is what the creator sees.) */
function captionRequired(contract, type) {
  const c = contract.shapes[type]?.caption;
  return c === undefined || c === 'required';
}

// contentTypes is DERIVED from `shapes`, so the list of valid types and the rules for them cannot drift apart.
const platform = (c) => Object.freeze({ ...c, contentTypes: Object.freeze(Object.keys(c.shapes)) });

export const CONTRACTS = Object.freeze({
  ig: platform({
    id: 'ig',
    label: 'Instagram',
    shapes: Object.freeze({
      reel: Object.freeze({ min: 1, max: 1, msg: 'a reel needs exactly 1 asset' }),
      carousel: Object.freeze({ min: 2, max: 10, msg: 'a carousel needs between 2 and 10 assets' }),
      // Story (Meta Content Publishing, media_type=STORIES): ONE JPEG image or MP4 video, no caption (Instagram ignores it),
      // no cover, expires after 24h. Aspect/duration/size are judged by media-specs.js (9:16 is advisory: letterboxed, not refused).
      story: Object.freeze({
        min: 1, max: 1, msg: 'a story needs exactly 1 asset',
        caption: 'none', cover: false, assetKinds: Object.freeze(['image', 'video']), checkMedia: true,
      }),
    }),

    // 2200 is INSTAGRAM'S cap, and it lives here rather than in schedule.js for exactly
    // that reason — YouTube's description limit is 5000. A platform limit enforced in the
    // generic layer is silently wrong for platform two, which is the whole failure mode
    // this refactor exists to prevent.
    captionMax: 2200,

    // Trial reels (Meta Content Publishing API, `trial_params` on the reel container; changelog
    // 2025-12-03). A trial shows the reel to non-followers first; graduating it to followers is
    // done in the Instagram app, never through the API. MANUAL = the creator graduates it by hand;
    // SS_PERFORMANCE = Instagram graduates it automatically if it performs. Reels only. Other
    // platforms declare `trial: null` — the key is mandatory (a contract test enforces it) so
    // "this platform has no trials" is a stated fact, not an omission.
    trial: Object.freeze({
      kinds: Object.freeze(['reel']),
      strategies: Object.freeze(['MANUAL', 'SS_PERFORMANCE']),
      // NO default, deliberately. A trial is something the creator chooses per reel; an assumed
      // default made every reel a trial, and Instagram rejected them with (#10) "Application does
      // not have permission for this action" (2026-11-12, 5 retries, post failed).
    }),

    /**
     * Problems with a create request, as human-readable strings. Empty array means valid.
     *
     * Returns a list rather than throwing or returning a boolean so the caller can report
     * EVERY problem at once — a creator fixing one field at a time, one request at a time,
     * is a worse experience than being told all of it up front.
     */
    validateCreate(input) { return validateShape(this, input); },
    captionRequired(type) { return captionRequired(this, type); },
  }),

  // TikTok: one vertical video per post, published by cron-worker/platforms/tiktok.js through the Content
  // Posting API. Photo posts are not scheduled (PULL_FROM_URL needs a verified domain). `captionMax` is
  // TikTok's title cap; the per-post choices (privacy, cover, ...) are validated by shared/tiktok-options.js.
  tt: platform({
    id: 'tt',
    label: 'TikTok',
    shapes: Object.freeze({
      reel: Object.freeze({ min: 1, max: 1, msg: 'a TikTok video needs exactly 1 asset', caption: 'optional' }),
    }),
    captionMax: 2200,
    trial: null,
    validateCreate(input) { return validateShape(this, input); },
    captionRequired(type) { return captionRequired(this, type); },
  }),
});

/** The contract for `platform`. Throws naming what IS registered — never a bare undefined
 *  that surfaces later as a confusing TypeError far from the real mistake. */
export function contractFor(platform) {
  const c = CONTRACTS[platform];
  if (!c) {
    throw new Error(
      `unknown platform ${JSON.stringify(platform)}. Supported: ${Object.keys(CONTRACTS).join(', ')}`,
    );
  }
  return c;
}

/** Every registered platform id. Sorted, so output and error messages are stable. */
export function supportedPlatforms() {
  return Object.keys(CONTRACTS).sort();
}

/**
 * Resolve the trial strategy for a post, for create and patch alike (one rule, two callers).
 *
 *   requested undefined/null -> not a trial (null). A trial is ONLY ever an explicit request.
 *   requested a value        -> must be a string the platform declares, on an eligible kind.
 *
 * Returns { strategy: string|null, problems: string[] }. Problems name what IS allowed, so a
 * caller can fix the request in one round trip.
 */
export function resolveTrialStrategy(contract, { type, requested } = {}) {
  const trial = contract.trial;
  const noValue = requested === undefined || requested === null;
  const label = contract.label || contract.id;

  if (!trial) {
    if (noValue) return { strategy: null, problems: [] };
    return { strategy: null, problems: [`${label} does not support trial posts`] };
  }

  const eligible = trial.kinds.includes(type);
  if (noValue) return { strategy: null, problems: [] };

  if (!eligible) {
    return {
      strategy: null,
      problems: [`a trial is only available for: ${trial.kinds.join(', ')} (this post is a ${type})`],
    };
  }
  if (typeof requested !== 'string' || !trial.strategies.includes(requested)) {
    return {
      strategy: null,
      problems: [
        `trial_strategy must be one of: ${trial.strategies.join(', ')} (got ${JSON.stringify(requested)})`,
      ],
    };
  }
  return { strategy: requested, problems: [] };
}
