-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0010_ig_tokens_whop_link.sql
--
-- Links a connected Instagram account back to the Whop membership that authorized it.
-- Written by /api/token on connect (after validating the license key against Whop's live
-- API), read by the webhook's membership.deactivated handler to revoke access the moment
-- a subscription lapses — see functions/api/whop/webhook.js.
ALTER TABLE ig_tokens ADD COLUMN whop_license_key TEXT;
ALTER TABLE ig_tokens ADD COLUMN whop_membership_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ig_tokens_whop_membership ON ig_tokens(whop_membership_id);
