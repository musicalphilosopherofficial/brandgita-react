/**
 * Media specs — which stored files does ONE clip need, given every place it will be posted?
 *
 * Founder, 2026-11-12: a clip is uploaded once and tagged with every platform it is bound for;
 * only a different ASPECT RATIO justifies a second stored file. This module is that rule. It is
 * PURE (no fetch, no env, no I/O), so the desktop app, the web app and the Pages Functions all
 * ask the same question and get the same answer.
 *
 * It lives apart from shared/platform-contracts.js on purpose. A contract there means "the cron
 * worker can PUBLISH this platform" — adding TikTok or YouTube to it would let POST /api/schedule
 * accept rows no adapter can publish. Media planning applies to uploads, whether or not a
 * platform is scheduled by the cron, so its registry is independent.
 *
 * SPEC FIELDS
 *   nativeAspect  width/height the platform is designed around (9/16 = vertical). A derived
 *                 rendition is made at exactly this aspect.
 *   aspectBand    the width/height range a clip may have and be posted AS-IS. Outside it, the
 *                 target needs its own rendition. These bands are PRODUCT choices (a 16:9 clip on
 *                 a Reel is technically accepted but looks wrong), not API rejections.
 *   maxDurationSec, maxBytes, minPx, maxPx   HARD limits, present only where the platform's own
 *                 docs state them (checked 2026-11-12). Absent = not enforced here, NOT "no limit":
 *                 Meta's Reels page gave no numbers, so Instagram declares none rather than a
 *                 remembered guess that would reject a valid clip.
 *     TikTok  developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *             360–4096 px each side, 10 minutes, 4 GB.
 *     YouTube support.google.com/youtube/answer/10059070  Shorts: up to 3 minutes, vertical.
 *
 * Keyed by the SAME platform ids as the platform contracts ('ig', 'yt', ...) so one id runs
 * through every layer; 'tt' is TikTok's.
 */

const VERTICAL_BAND = Object.freeze({ min: 0.53, max: 0.60 }); // 9:16 with a little slack for encoder rounding

export const MEDIA_SPECS = Object.freeze({
  ig: Object.freeze({
    reel: Object.freeze({ nativeAspect: 9 / 16, aspectBand: VERTICAL_BAND }),
  }),
  tt: Object.freeze({
    video: Object.freeze({
      nativeAspect: 9 / 16, aspectBand: VERTICAL_BAND,
      maxDurationSec: 600, maxBytes: 4 * 1024 ** 3, minPx: 360, maxPx: 4096,
    }),
  }),
  yt: Object.freeze({
    // A Short is vertical or square and at most 3 minutes.
    short: Object.freeze({ nativeAspect: 9 / 16, aspectBand: Object.freeze({ min: 0.4, max: 1.0 }), maxDurationSec: 180 }),
    video: Object.freeze({ nativeAspect: 16 / 9, aspectBand: Object.freeze({ min: 1.2, max: 2.4 }) }),
  }),
});

/** Names for messages. Kept beside the specs so an id can never be shown to a creator raw. */
export const PLATFORM_LABELS = Object.freeze({ ig: 'Instagram', tt: 'TikTok', yt: 'YouTube' });
const nameOf = (t) => `${PLATFORM_LABELS[t.platform] || t.platform} ${t.kind}`;
const label = (t) => `${t.platform}:${t.kind}`;
const inBand = (aspect, band) => aspect >= band.min && aspect <= band.max;
const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** width/height of a clip, or null when the dimensions are not usable numbers. */
export function aspectOf(clip) {
  if (!clip || !finitePositive(clip.width) || !finitePositive(clip.height)) return null;
  return clip.width / clip.height;
}

function supportedList() {
  return Object.entries(MEDIA_SPECS).map(([p, kinds]) => `${p} (${Object.keys(kinds).join(', ')})`).join('; ');
}

/** Limits that are the clip's own fault, not a matter of aspect — re-rendering the aspect won't fix them. */
function limitProblems(clip, spec, target) {
  const out = [];
  const name = nameOf(target);
  if (spec.maxDurationSec && finitePositive(clip.durationSec) && clip.durationSec > spec.maxDurationSec) {
    out.push(`${name}: clip is ${Math.round(clip.durationSec)}s but the limit is ${spec.maxDurationSec}s`);
  }
  if (spec.maxBytes && finitePositive(clip.bytes) && clip.bytes > spec.maxBytes) {
    out.push(`${name}: clip is larger than the ${spec.maxBytes}-byte limit`);
  }
  if (spec.minPx && Math.min(clip.width, clip.height) < spec.minPx) {
    out.push(`${name}: clip is ${clip.width}x${clip.height} but each side must be at least ${spec.minPx}px`);
  }
  if (spec.maxPx && Math.max(clip.width, clip.height) > spec.maxPx) {
    out.push(`${name}: clip is ${clip.width}x${clip.height} but each side must be at most ${spec.maxPx}px`);
  }
  return out;
}

/**
 * Plan the stored files for one clip.
 *
 * @param {{clip:{width,height,durationSec?,bytes?}, targets:{platform,kind}[]}} input
 * @returns {{renditions: {id,aspect,derived,targets}[], assignments: Record<string,string>, problems: string[]}}
 *   renditions   the files to STORE. 'source' is the clip as uploaded; 'derived-<n>' are re-renders
 *                at a target's native aspect, each shared by every target that can use it. A source
 *                no target can use is omitted — nothing stores a file nothing posts.
 *   assignments  "platform:kind" -> rendition id
 *   problems     human-readable; when non-empty the caller must not proceed.
 */
export function planRenditions({ clip, targets } = {}) {
  const problems = [];
  const empty = () => ({ renditions: [], assignments: {}, problems });

  const aspect = aspectOf(clip);
  if (aspect === null) {
    problems.push('clip must have positive numeric width and height');
    return empty();
  }

  // De-duplicate while keeping the caller's order stable.
  const seen = new Set();
  const wanted = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t || typeof t !== 'object') continue;
    if (seen.has(label(t))) continue;
    seen.add(label(t));
    wanted.push(t);
  }

  const known = [];
  for (const t of wanted) {
    const spec = MEDIA_SPECS[t.platform]?.[t.kind];
    if (!spec) {
      problems.push(
        MEDIA_SPECS[t.platform]
          ? `unknown kind ${JSON.stringify(t.kind)} for ${t.platform}. Supported: ${Object.keys(MEDIA_SPECS[t.platform]).join(', ')}`
          : `unknown platform ${JSON.stringify(t.platform)}. Supported: ${supportedList()}`,
      );
      continue;
    }
    problems.push(...limitProblems(clip, spec, t));
    known.push({ target: t, spec });
  }
  if (problems.length) return empty();

  const source = { id: 'source', aspect, derived: false, targets: [] };
  const derived = []; // {id, aspect, derived:true, targets:[]}
  const assignments = {};

  for (const { target, spec } of known) {
    if (inBand(aspect, spec.aspectBand)) {
      source.targets.push(target);
      assignments[label(target)] = 'source';
      continue;
    }
    // Needs a re-render. Join an existing derived file if its aspect is acceptable to this target.
    let home = derived.find((d) => inBand(d.aspect, spec.aspectBand));
    if (!home) {
      home = { id: `derived-${derived.length + 1}`, aspect: spec.nativeAspect, derived: true, targets: [] };
      derived.push(home);
    }
    home.targets.push(target);
    assignments[label(target)] = home.id;
  }

  const renditions = [...(source.targets.length ? [source] : []), ...derived];
  return { renditions, assignments, problems };
}
