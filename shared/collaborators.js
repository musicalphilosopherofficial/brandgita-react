/**
 * collaborators — Instagram collaborator invites on a post (`collaborators` on POST /<ig-user-id>/media).
 *
 * Meta docs read 2026-11-28: reels, feed images and carousels (the PARENT container), NOT stories; the publish reference says
 * "up to 3" usernames (another page says 5 — we hold to 3). The docs state nothing for Instagram Login (graph.instagram.com)
 * and no error behaviour for a bad or private username, and invite status can only be read through Facebook Login.
 * A contract opts a content type in with `shapes[type].collaborators: true`. PURE.
 */
import { USERNAME } from './user-tags.js';

export const MAX_COLLABORATORS = 3;

/** @returns {{usernames: string[]|null, problems: string[]}} usernames is null when there are none. */
export function validateCollaborators(input) {
  if (input === undefined || input === null) return { usernames: null, problems: [] };
  if (!Array.isArray(input)) return { usernames: null, problems: ['collaborators must be a list of usernames'] };
  const problems = [];
  const seen = new Set();
  const usernames = [];
  input.forEach((raw, i) => {
    const name = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
    if (!USERNAME.test(name)) { problems.push(`collaborators[${i}] must be a username: 1-30 letters, digits, "." or "_"`); return; }
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    usernames.push(name);
  });
  if (!problems.length && usernames.length > MAX_COLLABORATORS) problems.push(`a post can invite at most ${MAX_COLLABORATORS} collaborators`);
  return { usernames: problems.length || !usernames.length ? null : usernames, problems };
}
