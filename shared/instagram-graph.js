/**
 * The Instagram Graph API version, in ONE place. Publishing (cron-worker/platforms/instagram.js), the connection probe
 * (functions/api/connection.js) and the token exchange (functions/api/token.js) each pinned their own version (v21.0, v22.0, v22.0)
 * and drifted apart. Meta retires a version two years after its successor ships: v21.0 is removed 2027-01-21, after which calls
 * "default to the next oldest, usable version" — an upgrade on a date Meta picks, not us. Bumping here is a deliberate, tested change.
 * Changelog v21.0 -> v27.0 read 2026-11-25: no breaking change listed for media / media_publish / status_code / permalink / me.
 */
export const IG_GRAPH_VERSION = 'v27.0';
export const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;
