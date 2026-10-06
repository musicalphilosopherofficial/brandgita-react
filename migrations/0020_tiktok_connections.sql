-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0020_tiktok_connections.sql
--
-- One TikTok connection per Whop membership (the web app's identity — same key brand_kits uses).
-- Tokens are AES-GCM encrypted with TOKEN_ENC_KEY (functions/api/_crypto.js), never plaintext.
-- Additive: a new table, nothing existing is altered.
CREATE TABLE IF NOT EXISTS tiktok_connections (
  membership_id       TEXT PRIMARY KEY,
  open_id             TEXT NOT NULL,
  display_name        TEXT,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT NOT NULL,
  expires_at          TEXT NOT NULL,   -- ISO-8601 UTC, access token
  refresh_expires_at  TEXT NOT NULL,   -- ISO-8601 UTC, refresh token
  scope               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
