-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0022_scheduled_posts_posting_since.sql
--
-- posting_since: set in the SAME statement that claims a post (scheduled -> posting). A claim that is
--   still 'posting' after 10 minutes belongs to a worker that died (timeout, deploy, isolate
--   eviction), and the stale-claim reaper at the start of runDue (cron-worker/poster.js) hands it back.
--   Rows claimed before this migration have NULL, which the reaper treats as stale.
-- Additive nullable column only; no rebuild needed.
ALTER TABLE scheduled_posts ADD COLUMN posting_since TEXT;
