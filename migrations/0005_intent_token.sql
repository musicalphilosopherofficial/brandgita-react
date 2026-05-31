-- Single-use token that binds a fast-lane intent signal to the actual applicant
-- who just submitted the form. Without it, /intent accepts any email and bumps
-- priority_score by +100 — forgeable by anyone who knows an applicant's email.
-- waitlist.js issues this token on a successful submit and returns it to the
-- client; /intent only honours the bump if the token matches, then nulls it
-- (single-use, no replay).
--
-- Apply with:
--   npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0005_intent_token.sql

ALTER TABLE waitlist ADD COLUMN intent_token TEXT;
