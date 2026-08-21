/**
 * Frozen word list for human-readable media slugs.
 *
 * ⛔ THIS LIST IS IMMUTABLE. Do not add, remove, reorder, or re-spell an entry.
 *
 * The pair index is derived as `byte % PAIRS.length`, so ANY change to the array —
 * including appending — changes the modulus and therefore re-slugs EVERY existing
 * creator. Their already-uploaded R2 objects keep the old prefix, so their scheduled
 * posts stop resolving and fail to publish. That is a silent outage for people who did
 * nothing wrong.
 *
 * If new words are ever genuinely wanted, that is a `media-slug:v2:` migration with a
 * re-key pass, not an edit here. The version is already in the HMAC message for exactly
 * this reason. `_slugwords.test.js` pins a checksum of this file so the change cannot be
 * made by accident.
 *
 * Pairs are kept together and correctly attributed on purpose: these are real songs by
 * real artists, they appear in the CREATOR's public URLs, and mixing a song onto the
 * wrong artist would be putting a false statement about a real person in a public link.
 */

export const PAIRS = Object.freeze([
  Object.freeze(['eye-to-eye', 'taher-shah']),
  Object.freeze(['angel', 'taher-shah']),
  Object.freeze(['chick-chick', 'wang-rong']),
  Object.freeze(['gangnam-style', 'psy']),
  Object.freeze(['gentleman', 'psy']),
  Object.freeze(['selfie-maine-le-li', 'dhinchak-pooja']),
  Object.freeze(['dilon-ka-shooter', 'dhinchak-pooja']),
  Object.freeze(['thanda-thanda-pani', 'baba-sehgal']),
  Object.freeze(['tunak-tunak-tun', 'daler-mehndi']),
  Object.freeze(['why-this-kolaveri-di', 'dhanush']),
  Object.freeze(['pen-pineapple-apple-pen', 'pikotaro']),
  Object.freeze(['its-my-life', 'vennu-mallesh']),
  Object.freeze(['tum-to-thehre-pardesi', 'altaf-raja']),
  Object.freeze(['tandoori-nights', 'himesh-reshammiya']),
  Object.freeze(['aashiq-banaya-aapne', 'himesh-reshammiya']),
  Object.freeze(['hookah-bar', 'himesh-reshammiya']),
]);

/** `<song>-by-<artist>` for the pair selected by `byte`. Pure, total, no I/O. */
export function wordsFor(byte) {
  const [song, artist] = PAIRS[byte % PAIRS.length];
  return `${song}-by-${artist}`;
}
