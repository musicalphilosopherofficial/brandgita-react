-- Adds the applicant's self-reported region to the waitlist.
-- Used for the geo gate (EEA/UK/Switzerland are not served — see privacy policy)
-- and for analytics on accepted applicants.
-- Values: 'us-canada' | 'anz' | 'other' | 'uk-eu-swiss'
--
-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0003_add_region.sql

ALTER TABLE waitlist ADD COLUMN region TEXT;
