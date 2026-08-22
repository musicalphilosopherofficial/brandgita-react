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

export const CONTRACTS = Object.freeze({
  ig: Object.freeze({
    id: 'ig',
    label: 'Instagram',
    contentTypes: Object.freeze(['reel', 'carousel']),

    // 2200 is INSTAGRAM'S cap, and it lives here rather than in schedule.js for exactly
    // that reason — YouTube's description limit is 5000. A platform limit enforced in the
    // generic layer is silently wrong for platform two, which is the whole failure mode
    // this refactor exists to prevent.
    captionMax: 2200,

    /**
     * Problems with a create request, as human-readable strings. Empty array means valid.
     *
     * Returns a list rather than throwing or returning a boolean so the caller can report
     * EVERY problem at once — a creator fixing one field at a time, one request at a time,
     * is a worse experience than being told all of it up front.
     */
    validateCreate({ type, asset_keys, caption }) {
      const problems = [];

      if (!this.contentTypes.includes(type)) {
        problems.push(`type must be one of: ${this.contentTypes.join(', ')}`);
        // Everything below is type-specific, so stop here rather than emit cascading
        // nonsense about an asset count for a type that does not exist.
        return problems;
      }

      const n = Array.isArray(asset_keys) ? asset_keys.length : 0;
      if (type === 'reel' && n !== 1) {
        problems.push('a reel needs exactly 1 asset');
      }
      if (type === 'carousel' && (n < 2 || n > 10)) {
        problems.push('a carousel needs between 2 and 10 assets');
      }
      if (typeof caption === 'string' && caption.length > this.captionMax) {
        problems.push(`caption must be ${this.captionMax} characters or fewer`);
      }
      return problems;
    },
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
