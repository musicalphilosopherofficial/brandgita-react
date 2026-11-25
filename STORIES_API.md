# Instagram Stories — client contract

Stories are a **content type** (`type: "story"`), declared per platform in `shared/platform-contracts.js` (`shapes`) and
judged by `shared/media-specs.js` (`judgeFile`). Reel and carousel behaviour is unchanged. Adding Facebook Stories (or any
platform's story) is a new `shapes` / `MEDIA_SPECS` / adapter entry — not new validation or poster code.

Meta parameters verified against Meta's Content Publishing docs on 2026-11-25: `media_type=STORIES` with `image_url` or
`video_url`, poll `status_code` until `FINISHED`, then `POST /{ig-user-id}/media_publish`. The adapter sends no `caption`
and no `cover_url` for a story (Meta lists neither for stories).

## Create — `POST /api/schedule`

```json
{
  "id": "story-1",
  "type": "story",
  "asset_keys": ["<ig_user_id>/story/pic.jpg"],
  "post_at": "2026-12-01T09:00:00.000Z",
  "project_slug": "..."
}
```

- `platform` optional (defaults `ig`). `caption` and `cover_key` must be **absent** (an empty-string caption is accepted).
- `asset_keys`: exactly one key ending `.jpg`/`.jpeg` (image) or `.mp4` (video). PNG is rejected (Meta: JPEG only).
- `post_at`: same window as reels (a valid ISO date, no more than 45 days ahead).
- `trial_strategy` is refused on a story (trials are reels only).
- Optional `user_tags` — users the story mentions (Meta's `user_tags`, the only story parameter beyond the media itself):
  `[{ "username": "someone", "x": 0.5, "y": 0.8 }, { "username": "other" }]`. `username`: 1–30 letters/digits/`.`/`_` (a leading `@` is
  stripped); `x`/`y`: numbers 0–1 from the left/top edge, optional but **both or neither**; at most 20 (our cap — Meta states none);
  duplicates collapse. Stored on the post, returned by `GET /api/schedule`, settable/clearable (`null`) by `PATCH`. Refused on reel/
  carousel (`400 user_tags only apply to: story`). Meta states no error behaviour for a private or unknown username, so a bad
  username surfaces as the post failing at publish.
- Optional `media` — facts the client already knows, judged server-side:
  `{ "width": 1080, "height": 1920, "duration_sec": 30, "bytes": 20000000 }` (every field optional).
  Without it, the aspect tagged on the asset at upload time (`metadata.aspect`) is used for the warning only.

Response `200`: `{ "ok": true, "id", "post_at" }` — plus `"warnings": ["..."]` **only when non-empty**
(non-9:16 → "Instagram will letterbox or crop it. 9:16 (1080x1920) avoids that").
A repeat of the same account + asset + `post_at` returns the existing post with `"duplicate": true`.

### Limits enforced

| | Rule | Result |
|---|---|---|
| Assets | exactly 1, `.jpg`/`.jpeg`/`.mp4` | 400 |
| Caption | must be empty | 400 `a story cannot have a caption (Instagram ignores it): send an empty caption` |
| Cover | not allowed | 400 `a story cannot have a cover_key` |
| Aspect | 9:16 preferred; **any ratio accepted** | warning, not an error |
| Video length | 3–60 s | 400 (only when `media.duration_sec` is sent) |
| Size | image ≤ 8 MB, video ≤ 100 MB | 400 (only when `media.bytes` is sent) |

## New error strings (all HTTP 400 unless noted; no new codes — messages only)

- `a story needs exactly 1 asset`
- `a story asset must be a .jpg image or an .mp4 video (JPEG only for images); got "<key>"`
- `a story cannot have a caption (Instagram ignores it): send an empty caption`
- `a story cannot have a cover_key`
- `Instagram story: <w>x<h> ... ` (warning text, in `warnings`)
- `Instagram story: <n>s is over the 60s limit` / `under the 3s minimum` / `file is larger than the <n> MB limit`
- `trial ...` (trial_strategy on a story)
- `user_tags must be a list` / `user_tags[<i>] must be an object like {username, x?, y?}` / `user_tags[<i>].username must be 1-30 letters, digits, "." or "_"` / `user_tags[<i>] needs both x and y, or neither` / `user_tags[<i>].x and .y must be numbers from 0 to 1` / `user_tags can hold at most 20 users`
- `user_tags only apply to: story (this post is a reel)`
- `403 all asset keys must belong to your account` (unchanged)

`PATCH /api/schedule/:id` on a story also refuses a caption or a cover (`400`).

## Status values (unchanged vocabulary)

`scheduled` → `posting` → `posted` (with `permalink`) or `failed` (with `error`). Also `held_entitlement` and `missed`
(subscription lapsed), exactly as for reels. A transient failure (e.g. container `ERROR`/`EXPIRED`, poll timeout) returns the post
to `scheduled` with `retry_count` + `error` set and retries; after 5 attempts it is `failed`. Error strings a story can surface
on `GET /api/schedule`:

- `Container <id> processing returned status ERROR` (or `EXPIRED`)
- `Container <id> did not finish within <n>s`
- `Story has no asset keys`
- `TOKEN_EXPIRED` (permanent; reconnect Instagram)

Nothing publishes unless a row was scheduled; the story path reuses the reel path's claim, retry, backoff, token and
"already published" (`ig_media_id`) handling.

## Parameters Meta does NOT support on stories (so none are accepted)

Link, poll and location stickers; `collaborators`; `alt_text`; `poll_attachment`; `is_comment_prompt_used`; caption; `cover_url`
(Meta: "Publishing stickers (i.e., link, poll, location) is not supported"). A story that needs a link must be posted in the app.
Resumable upload (`upload_type=resumable`) is not used: containers are fed by URL, like reels.

## Deploy prerequisite

`scheduled_posts.type` has a database CHECK limited to `reel`/`carousel`. Migrations
`migrations/0025_scheduled_posts_open_type.sql` (applied 2026-11-25) and `0026_scheduled_posts_user_tags.sql` rebuilds the table without it (the contract validates types instead). Apply it
**before** deploying the Pages code, take a D1 export first, and do it when the queue is quiet. Until it is applied, creating a
story returns 500 (reel/carousel are unaffected). Then deploy the cron worker (`cd cron-worker && env -u CLOUDFLARE_API_TOKEN npx wrangler deploy`).

Note: the adapter uses Graph `v21.0`; Meta's docs now show `v27.0`. Stories work on the current version; bumping it is a separate,
deliberate change for all post types.
