-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0023_scheduled_posts_trial_strategy.sql
--
-- trial_strategy: Instagram trial reels. NULL = not a trial (every existing row, every carousel).
--   'MANUAL' | 'SS_PERFORMANCE' = publish the reel as a trial with that graduation strategy
--   (the creator graduates a MANUAL one in the Instagram app). The default is resolved when the
--   row is created (functions/api/schedule.js), never here and never in the cron worker.
-- Additive nullable column only; no rebuild needed.
ALTER TABLE scheduled_posts ADD COLUMN trial_strategy TEXT;
