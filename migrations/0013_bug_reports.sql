-- 0013_bug_reports.sql — in-app bug reports, complaints and feature requests.
--
-- This table is a QUEUE, not a log. POST /api/bugreport writes a pending row and
-- returns; a cron worker drains it into Notion and GitHub. The indirection is
-- deliberate: fanning out inline would let a burst hit Notion's ~3 req/s quota, handing
-- a stranger synchronous control over our third-party quota and bill. It also keeps the
-- Notion and GitHub tokens off any request path the public can drive.
--
-- Keyed on membership_id, not ig_user_id, on purpose: the most valuable report is
-- "the app broke during onboarding", and that creator has no connected Instagram
-- account yet. The Whop licence exists from first launch, so it covers the whole
-- lifecycle.

CREATE TABLE IF NOT EXISTS bug_reports (
  report_id     TEXT PRIMARY KEY,          -- opaque 'bg-<16 hex>'; what the creator quotes to support
  membership_id TEXT NOT NULL,             -- Whop membership; the quota + identity key
  report_type   TEXT NOT NULL,             -- 'bug' | 'complaint' | 'feature_request'

  -- JSON. Creator text is nested under `untrusted_user_input` because it lands verbatim
  -- in a GitHub issue body, and this repo runs `claude -p` delegation and cloud Claude
  -- sessions — an issue body is untrusted input to any future automated triage. The key
  -- name carries that boundary to every downstream reader, human or model.
  payload       TEXT NOT NULL,

  -- 'pending' -> 'synced' | 'failed'. The cron drain owns these transitions.
  status        TEXT NOT NULL DEFAULT 'pending',
  notion_page   TEXT,                      -- set by the drain; never returned to the client
  github_issue  TEXT,                      -- set by the drain; never returned to the client
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at     TEXT
);

-- The quota query is COUNT(*) WHERE membership_id = ? AND created_at > now-1day, and it
-- runs on EVERY report. Without this index it is a full scan, and the endpoint fails
-- closed on a slow read — so the index is a correctness concern, not just performance.
CREATE INDEX IF NOT EXISTS idx_bug_reports_quota
  ON bug_reports (membership_id, created_at);

-- The cron drain selects pending rows oldest-first.
CREATE INDEX IF NOT EXISTS idx_bug_reports_pending
  ON bug_reports (status, created_at);
