-- NOT YET APPLIED. Apply with (right Cloudflare account — brandgita.app@gmail.com):
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0024_assets_and_tiktok_scheduling.sql
--
-- 1. `assets`: one row per stored file, platform-agnostic. A file is uploaded once and TAGGED with
--    where it may go (targets) and its aspect; platforms attach to it through shared/media-specs.js,
--    contracts and adapters — never by owning a copy. Additive: a new table.
--      key               R2 object key (primary key; one row per stored object)
--      targets / tags    JSON arrays of strings
--      source_path_hash  client-supplied fingerprint; with `aspect` it makes a re-upload idempotent
--      uploaded_at       set once the bytes are in R2 (a row without it is only a reservation)
--      purged_at         set when the object is deleted (retention / unreferenced delete)
-- 2. scheduled_posts.tiktok_options: JSON of TikTok's per-post choices (privacy_level, title,
--    cover_timestamp_ms, interaction toggles, disclosure toggles). NULL for every non-TikTok row.
-- 3. scheduled_posts.tt_publish_id: TikTok's publish_id, saved once every chunk is uploaded so a
--    retry only polls status and never uploads (or posts) twice. Same role as ig_media_id.
CREATE TABLE IF NOT EXISTS assets (
  key               TEXT PRIMARY KEY,
  ig_user_id        TEXT NOT NULL,
  piece             TEXT,
  targets           TEXT NOT NULL DEFAULT '[]',
  aspect            TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  source_path_hash  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_at       TEXT,
  purged_at         TEXT
);
-- One live asset per (account, fingerprint, aspect). Partial: rows without a fingerprint are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_fingerprint
  ON assets(ig_user_id, source_path_hash, aspect)
  WHERE source_path_hash IS NOT NULL AND aspect IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(ig_user_id, created_at);

ALTER TABLE scheduled_posts ADD COLUMN tiktok_options TEXT;
ALTER TABLE scheduled_posts ADD COLUMN tt_publish_id TEXT;
