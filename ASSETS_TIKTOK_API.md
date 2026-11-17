# Tagged uploads, assets list, TikTok scheduling — API shapes

Not deployed yet. Needs migration `0024_assets_and_tiktok_scheduling.sql` first, and the cron worker needs
`TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` secrets (same values as the Pages project). All calls:
`Authorization: Bearer <desktop_token>`. Every old request shape still works; `metadata` is optional.

## Platform ids
Send `tiktok` / `instagram` / `youtube` or the short ids `tt` / `ig` / `yt`; they are the same platform.
The server stores and returns the short id (`tt`, `ig`).

## metadata (upload-url and multipart create)
```
{ piece?: string, targets?: ["tiktok"|"ig"|"youtube"], aspect?: "9:16"|"16:9"|"1:1"|"4:5",
  tags?: string[], source_path_hash?: string }
```
`targets` returns as canonical ids (`["tt","ig"]`). A target must accept the aspect (TikTok 9:16; IG reel 9:16/16:9,
IG carousel 1:1/4:5; YouTube Short 9:16, video 16:9) else 400 naming platform and aspect. Dedupe key =
`source_path_hash` + `aspect` (hash the CONTENT, not just the path).

### POST /api/upload-url  `{ keys:[one key], metadata }`
`200 { ok, uploads:[{ key, upload_url, existing?:true }], asset:{ key, existing:boolean, metadata } }`
If `existing` is true: `key` is the already-stored key. Do not upload; use that key. `metadata` needs exactly one key.

### POST /api/media-upload/{key}?action=create  `{ content_type, size, metadata }`
New: `200 { ok, upload_id, part_size }` (unchanged). Duplicate: `200 { ok, existing:true, key, metadata }` with no `upload_id`.
`action=complete` and the single PUT mark the asset uploaded; until then it is only a reservation.

## GET /api/assets?tag=&piece=&aspect=&target=&limit=
`200 { ok, assets:[{ key, piece, targets, aspect, tags, source_path_hash, created_at, uploaded_at, expires_at }] }`
Only uploaded, unpurged assets inside the bucket's 75-day expiry. `tag` is an exact match. Posted media is deleted
7 days after it posts and an unreferenced delete removes it too; those assets disappear from this list.

## POST /api/schedule (TikTok)
```
{ id, platform:"tiktok", asset_keys:[one key], post_at, caption?, title?,
  privacy_level?: "PUBLIC_TO_EVERYONE"|"MUTUAL_FOLLOW_FRIENDS"|"FOLLOWER_OF_CREATOR"|"SELF_ONLY" (default SELF_ONLY),
  cover_timestamp_ms?: int>=0 (default 0), disable_comment?, disable_duet?, disable_stitch?,
  brand_content_toggle?, brand_organic_toggle? }
```
`type` defaults to `reel`; `caption` is optional for TikTok (title, then caption, is the post title).
`200 { ok, id, post_at }` (IG now also returns `post_at`). The same account + platform + asset + post_at again returns
`{ ok, id:<existing id>, post_at, duplicate:true }` and creates nothing (a FAILED post does not block a re-schedule).
TikTok fields on an IG post are a 400, not ignored.

## GET /api/schedule?platform=tiktok&status=scheduled
`{ ok, posts:[...] }`; a TikTok row carries `privacy_level`, `title`, `cover_timestamp_ms` and the toggles flat.

## PATCH /api/schedule/{id}
Adds `privacy_level`, `title`, `cover_timestamp_ms`, toggles (TikTok posts only; merged over stored values).
Response includes the stored TikTok fields.

## At publish time (cron)
Re-queries TikTok `creator_info`; if the chosen privacy level is no longer offered the post fails at once with a
readable `error`. Permanent TikTok errors (unaudited-client rule, file rejected, ...) fail immediately; transient ones
retry up to 5 times. Expired TikTok token: `error: "TOKEN_EXPIRED"`. Photo posts are not scheduled.
`permalink` stays null for TikTok (TikTok returns no URL for private posts).
