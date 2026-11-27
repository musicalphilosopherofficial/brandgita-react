-- NOT YET APPLIED. Apply with (right Cloudflare account — brandgita.app@gmail.com), BEFORE deploying the code that reads it:
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0027_scheduled_posts_collaborators.sql
--
-- scheduled_posts.collaborators: JSON array of up to 3 Instagram usernames to invite as collaborators. NULL = none (all
-- existing rows). Additive: one nullable column, no rebuild. Validated by shared/collaborators.js.
ALTER TABLE scheduled_posts ADD COLUMN collaborators TEXT;
