-- Brand kits — a creator's intellectual property, kept so they cannot lose it.
--
-- WHY (founder, 2026-08-30): *"the intellectual property aesthetic and vision should be in
-- cloudflare."* Right, and only that. A kit on disk is ~430 KB, but the irreplaceable part is
-- about 32 KB of text:
--
--     vision-gita.md      who the creator is and what they stand for
--     aesthetic-gita.md   how that looks and sounds
--     brand-spec.json     the machine-readable core — colours, fonts, voice, tree, handle
--
-- Everything else stays local and is deliberately NOT here. Fonts are licensed third-party
-- binaries (320 KB of the 430 KB) and storing them would make us a redistributor of someone
-- else's typeface. tokens.css and index.html are DERIVED from brand-spec.json — syncing a
-- derivative guarantees it eventually disagrees with its source, so they are regenerated.
--
-- OWNERSHIP IS THE WHOP MEMBERSHIP, not the licence key. The membership id is stable per
-- customer and is not the secret the creator types, so a leaked row does not leak a credential.
-- It also survives a licence-key reset, which a device hash does not.
--
-- Local is not a cache to read through: the gallery must open instantly and offline. This is
-- the source of truth for the IP; ~/.bg/brand-gitas is a full working copy.

CREATE TABLE IF NOT EXISTS brand_kits (
  membership_id   TEXT NOT NULL,
  slug            TEXT NOT NULL,          -- 'musical-philosopher'
  vision_gita     TEXT,                   -- vision-gita.md
  aesthetic_gita  TEXT,                   -- aesthetic-gita.md
  brand_spec      TEXT,                   -- brand-spec.json, as written
  updated_at      TEXT NOT NULL,          -- ISO 8601, set by the server, never the client
  PRIMARY KEY (membership_id, slug)
);

-- The only query the app makes: every kit for one customer, newest first.
CREATE INDEX IF NOT EXISTS idx_brand_kits_member
  ON brand_kits (membership_id, updated_at DESC);
