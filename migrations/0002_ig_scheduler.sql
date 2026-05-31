-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0002_ig_scheduler.sql

CREATE TABLE IF NOT EXISTS ig_tokens (
  ig_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  token_expiry TEXT NOT NULL,  -- ISO UTC datetime
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,                -- UUID, set by caller
  ig_user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('reel','carousel')),
  asset_keys TEXT NOT NULL,           -- JSON array of R2 object keys
  cover_key TEXT,                     -- nullable, reel cover image R2 key
  caption TEXT NOT NULL DEFAULT '',
  post_at TEXT NOT NULL,              -- ISO UTC datetime
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','posting','posted','failed')),
  permalink TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_post_at
  ON scheduled_posts(post_at, status);
