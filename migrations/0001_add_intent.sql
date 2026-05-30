-- Smoke-test demand signal columns for the founding-access checkout.
-- intent_signal: which decoy payment method the applicant clicked
--                ('card' | 'paypal' | 'apple_pay' | 'google_pay'), NULL if none.
-- intent_at:     when they clicked (UTC, datetime('now')).
-- High-intent applicants also get +100 priority_score (handled in functions/intent.js).
--
-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0001_add_intent.sql

ALTER TABLE waitlist ADD COLUMN intent_signal TEXT;
ALTER TABLE waitlist ADD COLUMN intent_at TEXT;
