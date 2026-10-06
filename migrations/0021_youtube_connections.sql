-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0021_youtube_connections.sql
--
-- The YouTube (Google) REFRESH token, held in the cloud instead of on the creator's machine.
-- Encrypted with TOKEN_ENC_KEY (functions/api/_crypto.js). The desktop only ever receives a
-- short-lived access token from /api/youtube/access-token, never this one.
-- Keyed (membership, channel) because the app supports more than one connected channel.
-- Additive: a new table.
CREATE TABLE IF NOT EXISTS youtube_connections (
  membership_id      TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  channel_title      TEXT,
  refresh_token_enc  TEXT NOT NULL,
  scope              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (membership_id, channel_id)
);
