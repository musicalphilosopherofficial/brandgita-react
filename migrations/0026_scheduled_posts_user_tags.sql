-- NOT YET APPLIED. Apply with (right Cloudflare account — brandgita.app@gmail.com):
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute brandgita-waitlist --remote --file=./migrations/0026_scheduled_posts_user_tags.sql
--
-- scheduled_posts.user_tags: JSON array of {username, x?, y?} — the users a story mentions (Meta's `user_tags`). NULL for every
-- post that has none (all existing rows). Additive: one nullable column, no rebuild. Validated by shared/user-tags.js.
ALTER TABLE scheduled_posts ADD COLUMN user_tags TEXT;
