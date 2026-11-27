/**
 * user_tags — users mentioned in a post, validated ONCE for every platform that supports them.
 *
 * Shape (Meta Content Publishing, `user_tags` on a STORIES container; docs read 2026-11-25):
 *   [{ username: 'someone', x?: 0..1, y?: 0..1 }]
 * `username` is a public account name; x/y are floats 0.0–1.0 from the left/top edge and optional for stories. Meta states no
 * maximum and no error behaviour, so MAX_USER_TAGS is OUR cap (it keeps a request bounded), and x/y must come as a pair because
 * Meta does not say what a lone coordinate means.
 *
 * A contract opts a content type in with `shapes[type].userTags: true`; any other type is refused (never silently dropped).
 * PURE: no fetch, no env, no I/O.
 */
export const MAX_USER_TAGS = 20;

export const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** @returns {{tags: object[]|null, problems: string[]}} tags is the normalised list, or null when there are none. */
export function validateUserTags(input) {
  if (input === undefined || input === null) return { tags: null, problems: [] };
  if (!Array.isArray(input)) return { tags: null, problems: ['user_tags must be a list'] };
  if (input.length === 0) return { tags: null, problems: [] };
  if (input.length > MAX_USER_TAGS) return { tags: null, problems: [`user_tags can hold at most ${MAX_USER_TAGS} users`] };

  const problems = [];
  const seen = new Set();
  const tags = [];
  input.forEach((t, i) => {
    const at = `user_tags[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { problems.push(`${at} must be an object like {username, x?, y?}`); return; }
    const username = typeof t.username === 'string' ? t.username.replace(/^@/, '') : '';
    if (!USERNAME.test(username)) { problems.push(`${at}.username must be 1-30 letters, digits, "." or "_"`); return; }
    const hasX = t.x !== undefined; const hasY = t.y !== undefined;
    if (hasX !== hasY) { problems.push(`${at} needs both x and y, or neither`); return; }
    if (hasX && (!inUnit(t.x) || !inUnit(t.y))) { problems.push(`${at}.x and .y must be numbers from 0 to 1`); return; }
    const key = username.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(hasX ? { username, x: t.x, y: t.y } : { username });
  });
  return { tags: problems.length ? null : tags, problems };
}
