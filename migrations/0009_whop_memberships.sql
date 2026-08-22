-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0009_whop_memberships.sql
--
-- Membership state mirrored from Whop's membership.activated / membership.deactivated
-- webhooks (functions/api/whop/webhook.js). This is the RECEIVER + STORAGE half of
-- replacing the shared API_SECRET on /api/token with real per-customer entitlement
-- (decisions/founder-action-queue.md item 2) — /api/token does not check this table yet;
-- that is a separate, later change once the desktop app has a way to identify which
-- Whop customer it belongs to.
CREATE TABLE IF NOT EXISTS whop_memberships (
  membership_id TEXT PRIMARY KEY,        -- Whop's data.id — stable across status changes
  whop_user_id  TEXT NOT NULL,           -- data.user.id
  email         TEXT,                    -- data.user.email — nullable, not guaranteed present
  status        TEXT NOT NULL CHECK(status IN ('active','inactive')),
  plan_id       TEXT,
  product_id    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_whop_memberships_user ON whop_memberships(whop_user_id);
