-- Study inbox: phone-screenshot study-records awaiting ingestion by the local app.
-- See decisions/study-inbox-sync.md. Apply: wrangler d1 migrations apply brandgita-waitlist

CREATE TABLE IF NOT EXISTS study_inbox (
  id         TEXT PRIMARY KEY,
  record     TEXT NOT NULL,                       -- the JSON study-record from the /study skill
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | consumed
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_study_inbox_status ON study_inbox(status);
