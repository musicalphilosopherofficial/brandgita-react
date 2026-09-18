-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0016_scheduled_posts_entitlement_hold.sql
--
-- Adds the two states a post needs when its owner's subscription lapses, plus `held_at`:
--
--   held_entitlement  parked because the membership went inactive. NOT a failure — the
--                     commonest cause is a card that bounced, and telling a paying customer
--                     their posts "failed" when they merely need to update a card is a lie
--                     that costs trust. Resumes automatically on membership.activated.
--   missed            was held past its slot and is now too stale to fire unasked. Surfaced
--                     to the creator to reschedule or discard — never silently dropped,
--                     never auto-published in a burst on reactivation.
--
-- WHY THIS IS A TABLE REBUILD, NOT AN ALTER. migration 0002 put
-- CHECK(status IN ('scheduled','posting','posted','failed')) on this column, and SQLite cannot
-- ALTER a CHECK — only recreate the table under it.
--
-- WHY THE REBUILD DROPS THE CHECK RATHER THAN WIDENING IT. This is migration 0012's own
-- argument, applied to the column next door. 0012 declined to put a CHECK on `platform`
-- because "adding a second immutable CHECK to the column whose entire purpose is to make
-- platforms extensible would bake in the same mistake a second time". `status` is the same
-- kind of column: it has already gained states twice and will gain more (a per-platform
-- pending state, a paused state). Widening the CHECK to six values would buy one migration of
-- safety and charge a full table rebuild for the seventh. Status validity is enforced in code
-- instead — cron-worker/poster.js owns the transitions, and the entitlement predicate there
-- decides what may publish; the database's job here is storage, not vocabulary.
--
-- DEPLOY NOTE: this rewrites a LIVE table that the cron reads every 60 seconds. It is small
-- (one row per scheduled post) and runs in a transaction, so the window is brief — but run it
-- when the queue is quiet rather than seconds before a batch is due, and take a D1 export
-- first. A cron tick landing mid-transaction sees the pre-migration table and simply finds
-- nothing due; it does not corrupt anything.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE scheduled_posts_new (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('reel','carousel')),
  asset_keys TEXT NOT NULL,
  cover_key TEXT,
  caption TEXT NOT NULL DEFAULT '',
  post_at TEXT NOT NULL,
  -- No CHECK: see the rationale above.
  status TEXT NOT NULL DEFAULT 'scheduled',
  permalink TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  platform TEXT NOT NULL DEFAULT 'ig',
  -- When the post was parked. Null for every row that has never been held. Used to tell a
  -- creator how long something has been waiting, and to age out holds that are never resumed.
  held_at TEXT
);

-- Column list is explicit on BOTH sides: a bare INSERT ... SELECT * would silently
-- mis-assign if the source column order ever differed from what this migration assumes.
INSERT INTO scheduled_posts_new
  (id, ig_user_id, type, asset_keys, cover_key, caption, post_at, status,
   permalink, error, retry_count, created_at, platform, held_at)
SELECT
   id, ig_user_id, type, asset_keys, cover_key, caption, post_at, status,
   permalink, error, retry_count, created_at, platform, NULL
  FROM scheduled_posts;

DROP TABLE scheduled_posts;

ALTER TABLE scheduled_posts_new RENAME TO scheduled_posts;

-- Recreate 0002's index: a DROP TABLE takes its indexes with it.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_post_at
  ON scheduled_posts(post_at, status);

COMMIT;

PRAGMA foreign_keys=ON;
