-- NOT YET APPLIED. Apply with (right Cloudflare account — brandgita.app@gmail.com), when the queue is quiet:
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 export brandgita-waitlist --remote --output=./backup-before-0025.sql
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0025_scheduled_posts_open_type.sql
--
-- Drops CHECK(type IN ('reel','carousel')) from scheduled_posts so a post can be a STORY (and whatever content type the
-- next platform declares). SQLite cannot ALTER a CHECK — only rebuild the table.
--
-- WHY THE CHECK IS DROPPED, NOT WIDENED. Migration 0012 declined a CHECK on `platform` and 0016 dropped the one on `status`
-- for the same reason: a CHECK on a column whose vocabulary grows charges a full table rebuild for every new value. The valid
-- types per platform live in ONE place — shared/platform-contracts.js (`shapes`) — which POST /api/schedule validates at create
-- time and cron-worker/poster.js re-checks at publish time. The database's job here is storage, not vocabulary.
--
-- Same shape as 0016's rebuild: explicit column lists on both sides, then the due-query index recreated (a DROP TABLE takes its
-- indexes with it). Column set = the live table as of 0024 (queried from remote D1 2026-11-25).
--
-- DEPLOY NOTE: rewrites a LIVE table the cron reads every 60 s. It is small and runs in a transaction; a cron tick landing
-- mid-migration sees the pre-migration table and finds nothing due. Take the export above first.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE scheduled_posts_new (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  -- No CHECK: see the rationale above.
  type TEXT NOT NULL,
  asset_keys TEXT NOT NULL,
  cover_key TEXT,
  caption TEXT NOT NULL DEFAULT '',
  post_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  permalink TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  platform TEXT NOT NULL DEFAULT 'ig',
  held_at TEXT,
  ig_media_id TEXT,
  media_purged_at TEXT,
  posting_since TEXT,
  trial_strategy TEXT,
  tiktok_options TEXT,
  tt_publish_id TEXT
);

INSERT INTO scheduled_posts_new
  (id, ig_user_id, type, asset_keys, cover_key, caption, post_at, status, permalink, error, retry_count, created_at,
   platform, held_at, ig_media_id, media_purged_at, posting_since, trial_strategy, tiktok_options, tt_publish_id)
SELECT
   id, ig_user_id, type, asset_keys, cover_key, caption, post_at, status, permalink, error, retry_count, created_at,
   platform, held_at, ig_media_id, media_purged_at, posting_since, trial_strategy, tiktok_options, tt_publish_id
  FROM scheduled_posts;

DROP TABLE scheduled_posts;

ALTER TABLE scheduled_posts_new RENAME TO scheduled_posts;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_post_at
  ON scheduled_posts(post_at, status);

COMMIT;

PRAGMA foreign_keys=ON;
