/**
 * TikTok's per-post choices, validated once for create (POST /api/schedule) and change (PATCH).
 * PURE. Stored as one JSON column (scheduled_posts.tiktok_options); the cron adapter reads it back.
 *
 *   privacy_level       one of TikTok's four values. Default SELF_ONLY — the safe server-side default
 *                       (and the only value TikTok allows an unaudited client to use). The creator-facing
 *                       UI must still make the creator choose; this default is a backstop, not a UX.
 *   title               the post's title, up to 2200 characters. Omitted = the post's caption is used.
 *   cover_timestamp_ms  the video frame used as the cover. Default 0 (the first frame).
 *   disable_comment / disable_duet / disable_stitch / brand_content_toggle / brand_organic_toggle
 *                       optional booleans, passed through when given.
 */
export const PRIVACY_LEVELS = Object.freeze(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
export const DEFAULT_PRIVACY_LEVEL = 'SELF_ONLY';
export const TITLE_MAX = 2200;
const BOOLEANS = ['disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle', 'brand_organic_toggle'];
export const TIKTOK_FIELDS = Object.freeze(['privacy_level', 'title', 'cover_timestamp_ms', ...BOOLEANS]);

/**
 * @param {object} input  the request body (or the subset of it)
 * @param {{current?: object}} opts  for PATCH: the stored options, which the given fields are merged over
 * @returns {{options: object, problems: string[], given: string[]}}  `given` = which fields the request set
 */
export function resolveTikTokOptions(input = {}, { current = null } = {}) {
  const problems = [];
  const given = TIKTOK_FIELDS.filter((f) => input[f] !== undefined);
  const base = current
    ? { ...current }
    : { privacy_level: DEFAULT_PRIVACY_LEVEL, cover_timestamp_ms: 0 };
  const options = { ...base };

  if (input.privacy_level !== undefined) {
    if (PRIVACY_LEVELS.includes(input.privacy_level)) options.privacy_level = input.privacy_level;
    else problems.push(`privacy_level must be one of: ${PRIVACY_LEVELS.join(', ')} (got ${JSON.stringify(input.privacy_level)})`);
  }
  if (input.title !== undefined) {
    if (typeof input.title === 'string' && input.title.length <= TITLE_MAX) options.title = input.title;
    else problems.push(`title must be a string of at most ${TITLE_MAX} characters`);
  }
  if (input.cover_timestamp_ms !== undefined) {
    if (Number.isInteger(input.cover_timestamp_ms) && input.cover_timestamp_ms >= 0) options.cover_timestamp_ms = input.cover_timestamp_ms;
    else problems.push('cover_timestamp_ms must be a whole number of milliseconds, 0 or more');
  }
  for (const f of BOOLEANS) {
    if (input[f] === undefined) continue;
    if (typeof input[f] === 'boolean') options[f] = input[f];
    else problems.push(`${f} must be true or false`);
  }
  return { options, problems, given };
}

/** A stored row's per-post choices live in one JSON column; clients see them as flat fields. */
export function flattenTikTok(row) {
  const { tiktok_options: raw, ...rest } = row;
  if (!raw) return rest;
  try { return { ...rest, ...JSON.parse(raw) }; } catch { return rest; }
}
