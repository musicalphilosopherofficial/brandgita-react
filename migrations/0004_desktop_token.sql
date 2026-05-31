-- Per-user bearer token for desktop app auth.
-- Minted after OAuth completes (POST /api/token), returned to the desktop,
-- stored here keyed to ig_user_id. Replaces the shared API_SECRET on all
-- user-scoped endpoints so a leaked token can only affect one user's data.
-- The shared API_SECRET is retained only for internal/admin calls.
--
-- Applied manually (columns already added via wrangler d1 execute):
--   ALTER TABLE ig_tokens ADD COLUMN desktop_token TEXT;
--   ALTER TABLE ig_tokens ADD COLUMN desktop_token_created_at TEXT;
--
-- This migration is a no-op if the columns already exist (run after the above).

SELECT 1; -- columns already applied above
