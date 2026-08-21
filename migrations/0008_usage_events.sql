-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0008_usage_events.sql
--
-- Usage telemetry ingest — the "how much is the app used, and where" stream.
-- Spec: decisions/usage-telemetry-conversion-signal.md (handed off 2026-06-01, built 2026-08-21).
--
-- PRIVACY: this table holds NO content. No footage, no filenames, no transcripts, no
-- captions. Only that a feature ran, keyed to a one-way SHA-256 of the trial licence.
-- `props` is allowlisted per event on BOTH client and server, so an unknown key cannot
-- ride along even if a future call site passes one by mistake.
CREATE TABLE IF NOT EXISTS usage_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_hash TEXT NOT NULL,
  event        TEXT NOT NULL,
  props        TEXT,                        -- JSON string, allowlisted server-side, <=256 B
  app_version  TEXT,
  os           TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-trial rollup (the scorecard) groups by licence.
CREATE INDEX IF NOT EXISTS idx_usage_license ON usage_events(license_hash);
-- The ladder funnel counts by event.
CREATE INDEX IF NOT EXISTS idx_usage_event   ON usage_events(event);
-- Every dashboard query is time-bounded ("last 30 days"), and D1 bills ROWS READ — without
-- this the funnel scans the whole table on each load. Same class of mistake as the missing
-- ig_tokens(token_expiry) index found on 2026-08-21; not repeating it in a new table.
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
