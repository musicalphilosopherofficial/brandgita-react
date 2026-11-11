/**
 * Media specs — which of the creator's files serves each platform, and which files are stored.
 *
 * Founder, 2026-11-12: a file is uploaded ONCE and tagged with every platform it will be posted to;
 * a second stored file exists only when the creator supplied a different ASPECT RATIO. The creator
 * supplies the per-aspect files — nothing in this repo re-renders video. This module is the
 * assignment rule: given the files on offer and the targets, pick for each target a file that fits
 * it, using as few stored files as possible, and say plainly when a target has no fitting file.
 *
 * PURE (no fetch, no env, no I/O): the desktop app, the web app and the Pages Functions all ask the
 * same question and get the same answer.
 *
 * It lives apart from shared/platform-contracts.js on purpose. A contract there means "the cron
 * worker can PUBLISH this platform" — adding TikTok or YouTube to it would let POST /api/schedule
 * accept rows no adapter can publish. Media planning applies to uploads whether or not a platform is
 * scheduled by the cron, so its registry is independent.
 *
 * SPEC FIELDS
 *   nativeAspect  width/height the platform is built around (9/16 = vertical). Used only as the
 *                 tie-break when two files both fit: the one nearest native wins.
 *   aspectBands   the width/height ranges a file may have and be posted AS-IS (a LIST: a Reel takes
 *                 vertical and 16:9 but not the square between them).
 *     Founder-stated (2026-11-12, corrected three times): IG Reel = vertical or 16:9; IG carousel
 *     = 1:1 or 4:5 (for now); TikTok and YouTube Short = vertical only; YouTube video = 16:9. These
 *     bands are the founder's rule and were NOT derived from API docs — Meta's Reels page gave no
 *     aspect numbers and TikTok's docs state none; widening a band from "the docs don't forbid it"
 *     was the mistake that was corrected.
 *   maxDurationSec, maxBytes, minPx, maxPx   HARD limits, present only where the platform's own docs
 *     state them (checked 2026-11-12). Absent = not enforced here, NOT "no limit".
 *       TikTok  developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *               360–4096 px each side, 10 minutes, 4 GB.
 *       YouTube support.google.com/youtube/answer/10059070  Shorts: up to 3 minutes.
 *
 * Keyed by the SAME platform ids as the platform contracts ('ig', 'yt', ...) so one id runs through
 * every layer; 'tt' is TikTok's.
 */

const band = (min, max) => Object.freeze({ min, max });
const VERTICAL = band(0.5, 0.6);       // 9:16 (0.5625) with slack for encoder rounding
const LANDSCAPE = band(1.7, 1.85);     // 16:9 (1.778)
const SQUARE = band(0.95, 1.05);       // 1:1
const FOUR_FIVE = band(0.78, 0.82);    // 4:5 (0.8)

export const MEDIA_SPECS = Object.freeze({
  ig: Object.freeze({
    // A Reel takes vertical or 16:9 — NOT square or 4:5 (founder, 2026-11-12).
    reel: Object.freeze({ nativeAspect: 9 / 16, aspectBands: Object.freeze([VERTICAL, LANDSCAPE]) }),
    // Carousels take 1:1 and 4:5 for now (founder, 2026-11-12). Note: this entry judges ONE file; a
    // carousel is 2–10 slides and each slide is checked separately by the caller.
    carousel: Object.freeze({ nativeAspect: 1, aspectBands: Object.freeze([SQUARE, FOUR_FIVE]) }),
  }),
  tt: Object.freeze({
    video: Object.freeze({
      nativeAspect: 9 / 16, aspectBands: Object.freeze([VERTICAL]),
      maxDurationSec: 600, maxBytes: 4 * 1024 ** 3, minPx: 360, maxPx: 4096,
    }),
  }),
  yt: Object.freeze({
    // A Short is vertical and at most 3 minutes (square is NOT accepted — founder, 2026-11-12).
    short: Object.freeze({ nativeAspect: 9 / 16, aspectBands: Object.freeze([VERTICAL]), maxDurationSec: 180 }),
    video: Object.freeze({ nativeAspect: 16 / 9, aspectBands: Object.freeze([LANDSCAPE]) }),
  }),
});

/** Names for messages, so a platform id is never shown to a creator raw. */
export const PLATFORM_LABELS = Object.freeze({ ig: 'Instagram', tt: 'TikTok', yt: 'YouTube' });
const nameOf = (t) => `${PLATFORM_LABELS[t.platform] || t.platform} ${t.kind}`;
const keyOf = (t) => `${t.platform}:${t.kind}`;
const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const round2 = (n) => Math.round(n * 100) / 100;

function supportedList() {
  return Object.entries(MEDIA_SPECS).map(([p, kinds]) => `${p} (${Object.keys(kinds).join(', ')})`).join('; ');
}

/** Why `file` cannot serve a platform with `spec`, or null when it can. */
function whyNot(file, spec) {
  const aspect = file.width / file.height;
  if (!spec.aspectBands.some((b) => aspect >= b.min && aspect <= b.max)) {
    const wants = spec.aspectBands.map((b) => `${round2(b.min)}–${round2(b.max)}`).join(' or ');
    return `${file.id} is ${file.width}x${file.height} (width÷height ${round2(aspect)}), which is outside ${wants}`;
  }
  if (spec.maxDurationSec && finitePositive(file.durationSec) && file.durationSec > spec.maxDurationSec) {
    return `${file.id} is ${Math.round(file.durationSec)}s but the limit is ${spec.maxDurationSec}s`;
  }
  if (spec.maxBytes && finitePositive(file.bytes) && file.bytes > spec.maxBytes) {
    return `${file.id} is larger than the ${spec.maxBytes}-byte limit`;
  }
  if (spec.minPx && Math.min(file.width, file.height) < spec.minPx) {
    return `${file.id} is ${file.width}x${file.height} but each side must be at least ${spec.minPx}px`;
  }
  if (spec.maxPx && Math.max(file.width, file.height) > spec.maxPx) {
    return `${file.id} is ${file.width}x${file.height} but each side must be at most ${spec.maxPx}px`;
  }
  return null;
}

/**
 * @param {{files: {id, width, height, durationSec?, bytes?}[], targets: {platform, kind}[]}} input
 * @returns {{stored: {id, targets}[], assignments: Record<string,string>, unused: string[], problems: string[]}}
 *   stored       the files to keep, each with the targets it serves. A file nothing posts is not stored.
 *   assignments  "platform:kind" -> file id
 *   unused       ids of supplied files no target needed
 *   problems     human-readable; when non-empty the caller must not proceed
 */
export function assignFiles({ files, targets } = {}) {
  const problems = [];
  const fail = () => ({ stored: [], assignments: {}, unused: [], problems });

  // ── validate files ──
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    problems.push('no files supplied: give at least one file with {id, width, height}');
    return fail();
  }
  const ids = new Set();
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id) {
      problems.push('every file needs a string id');
    } else if (!finitePositive(f.width) || !finitePositive(f.height)) {
      problems.push(`file ${f.id} needs positive numeric width and height`);
    } else if (ids.has(f.id)) {
      problems.push(`duplicate file id ${f.id}: an id must name exactly one file`);
    } else {
      ids.add(f.id);
    }
  }
  if (problems.length) return fail();

  // ── validate targets (de-duplicated, caller's order kept) ──
  const seen = new Set();
  const wanted = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t || typeof t !== 'object' || seen.has(keyOf(t))) continue;
    seen.add(keyOf(t));
    const spec = MEDIA_SPECS[t.platform]?.[t.kind];
    if (!spec) {
      problems.push(
        MEDIA_SPECS[t.platform]
          ? `unknown kind ${JSON.stringify(t.kind)} for ${t.platform}. Supported: ${Object.keys(MEDIA_SPECS[t.platform]).join(', ')}`
          : `unknown platform ${JSON.stringify(t.platform)}. Supported: ${supportedList()}`,
      );
      continue;
    }
    wanted.push({ target: t, spec });
  }
  if (problems.length) return fail();

  // ── which files can serve which target ──
  const eligible = new Map(); // targetKey -> file[] that fit
  for (const { target, spec } of wanted) {
    const fits = [];
    const reasons = [];
    for (const f of list) {
      const why = whyNot(f, spec);
      if (why) reasons.push(why); else fits.push(f);
    }
    if (fits.length === 0) {
      problems.push(`${nameOf(target)}: none of your files fits. ${reasons.join('; ')}`);
    }
    eligible.set(keyOf(target), fits);
  }
  if (problems.length) return { stored: [], assignments: {}, unused: list.map((f) => f.id), problems };

  // ── fewest stored files: greedy set cover. Pick the file serving the most unserved targets; ties go
  //    to the file nearest those targets' native aspect, then to the caller's order (deterministic). ──
  const unserved = new Set(wanted.map(({ target }) => keyOf(target)));
  const byKey = new Map(wanted.map((w) => [keyOf(w.target), w]));
  const chosen = []; // {file, targets:[]}
  const assignments = {};
  while (unserved.size) {
    let best = null;
    list.forEach((f, order) => {
      const serves = [...unserved].filter((k) => eligible.get(k).includes(f));
      if (!serves.length) return;
      const drift = serves.reduce((sum, k) => sum + Math.abs(Math.log((f.width / f.height) / byKey.get(k).spec.nativeAspect)), 0);
      const score = { f, serves, order, drift };
      if (!best
        || serves.length > best.serves.length
        || (serves.length === best.serves.length && drift < best.drift - 1e-12)
        || (serves.length === best.serves.length && Math.abs(drift - best.drift) <= 1e-12 && order < best.order)) {
        best = score;
      }
    });
    chosen.push({ file: best.f, targets: best.serves.map((k) => byKey.get(k).target) });
    for (const k of best.serves) { assignments[k] = best.f.id; unserved.delete(k); }
  }

  const stored = chosen.map(({ file, targets: ts }) => ({ id: file.id, targets: ts }));
  const used = new Set(stored.map((s) => s.id));
  return { stored, assignments, unused: list.map((f) => f.id).filter((id) => !used.has(id)), problems };
}
