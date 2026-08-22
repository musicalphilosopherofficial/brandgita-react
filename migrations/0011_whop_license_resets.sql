-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0011_whop_license_resets.sql
--
-- Cooldown tracking for the device-lock reset (functions/api/_whop.js resetDeviceLock).
--
-- NOT stored in Whop's own membership metadata, despite that being the more obvious
-- place — confirmed live 2026-08-22 that PATCH /api/v1/memberships/{id} is ALL-OR-
-- NOTHING: an empty {"metadata":{}} wipes the whole object, and a non-empty one MERGES
-- (cannot delete a single key like hwid while preserving another like last_reset_at).
-- There is no way to selectively clear the device lock while keeping our own cooldown
-- marker in the same object, so the two are tracked in two different places instead:
-- Whop owns the device binding (hwid), we own the cooldown timer.
CREATE TABLE IF NOT EXISTS whop_license_resets (
  membership_id TEXT PRIMARY KEY,
  last_reset_at TEXT NOT NULL
);
