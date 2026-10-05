-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0019_scheduled_posts_recovery.sql
--
-- ig_media_id: set the moment Instagram's media_publish returns, BEFORE the permalink lookup.
--   A retry that finds one only fetches the link and never publishes again — without it, a
--   permalink hiccup after a successful publish led the next retry to post a second copy.
-- media_purged_at: set once a posted post's R2 media has been deleted (7 days after it posts —
--   shared/media-retention.js), so the daily sweep never re-scans it.
-- Additive nullable columns only; no rebuild needed.
ALTER TABLE scheduled_posts ADD COLUMN ig_media_id TEXT;
ALTER TABLE scheduled_posts ADD COLUMN media_purged_at TEXT;
