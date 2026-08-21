# Handoff — Scheduling API: reschedule + connection health

**Repo:** `brandgita-react` (Cloudflare Pages Functions + cron Worker)
**Branch:** `feature/patch-schedule-endpoint` (pushed) · **HEAD:** `7b19a91`
**PR target:** `bg/v1` (never `main` directly)
**Companion docs:** `cron-worker/DESKTOP_HANDOFF.md` (endpoints that already existed),
`cron-worker/PATCH_SCHEDULE_SPEC.md` (full PATCH spec)
**Date:** 2026-08-21

---

## TL;DR

Two new server endpoints, both bearer-auth scoped to one `ig_user_id`, both tested,
both pushed. No new code was needed for "put the user token on Cloudflare" — that
was already the live architecture; Meta approval just flips it from test-users to
all creators.

| Endpoint | Purpose | Status |
|---|---|---|
| `PATCH /api/schedule/{id}` | Move a scheduled post's day without re-uploading media | ✅ built + tested |
| `GET /api/connection` | Pre-flight check that a stored IG token can still publish | ✅ built + tested |

Full API test suite: **26/26 green** (`node --test functions/api/*.test.js functions/api/schedule.patch.test.js`).

---

## 1. `PATCH /api/schedule/{id}` — reschedule without re-upload

**File:** `functions/api/schedule/[id].js` (added alongside the existing `DELETE`)
**Tests:** `functions/api/schedule.patch.test.js` (14 cases)

**Why:** moving a post used to be `DELETE`+`POST`, and `DELETE` wipes the post's R2
media — so changing one timestamp forced a full re-upload of the reel/every slide.
On a 14-day calendar, blanking one day cascaded into re-uploading a dozen posts.
PATCH makes it a dozen timestamp writes and **zero bytes transferred**.

**Contract:**
- Accepts `{ post_at }` (required) and `{ caption }` (optional).
- **Rejects** `asset_keys`, `type`, `cover_key`, `id`, `ig_user_id`, or any unknown
  key with `400` (swapping media = a different post the cron never validated).
- Guards mirror `DELETE`: ownership mismatch → **404** (no existence leak);
  non-`scheduled` status → **409**; `post_at` must be in the future; caption ≤ 2200.
- **Horizon: 30 days max** (hard ceiling — `RESCHEDULE_HORIZON_MS`). Matches the
  baseline `TierPolicy.can_schedule()` allowance.
- **One D1 `UPDATE`, zero R2 calls.** Returns `{ ok, id, post_at, caption }`.

---

## 2. `GET /api/connection` — pre-flight publish-health check

**File:** `functions/api/connection.js`
**Tests:** `functions/api/connection.test.js` (7 cases)

**Why:** the desktop calls this before firing the first scheduled post, so a creator
sees a "reconnect Instagram" prompt at their keyboard instead of a silent
`TOKEN_EXPIRED` hours later in the cron worker.

**How:** probes Meta's `/{ig_user_id}/content_publishing_limit`, which requires
**both** a live token **and** the content-publish permission — so a 200 proves real
publish capability, not just authentication. Read-only: decrypts the token, touches
no rows.

**Returns 200 + a status object for every connection state** (branch on `publishable`):

| State | Response |
|---|---|
| Valid | `{ ok, connected:true, publishable:true, expires_at, quota_usage, quota_total }` |
| Never connected / revoked | `{ connected:false, publishable:false, reason:'not_connected' }` |
| Expired/invalid (Meta 190) | `{ connected:true, publishable:false, reason:'token_invalid' }` |
| Publish scope missing | `{ connected:true, publishable:false, reason:'permission' }` |
| Meta unreachable | `{ connected:true, publishable:null, reason:'check_failed' }` (do NOT prompt reconnect) |

`{ ok:false }` + non-200 is reserved for real DB/decrypt faults. `quota_usage` /
`quota_total` expose the rolling 24h limit so the desktop can warn before tripping
Meta's ~50-posts/day ceiling.

---

## Already live — IG token on Cloudflare (no new work)

The Meta approval unlocks production use of an architecture already shipped (May 31):

- `functions/api/token.js` — OAuth exchange stores the 60-day long-lived IG token in
  D1 `ig_tokens.access_token`, **AES-256-GCM encrypted** (`_crypto.js`, `v1:` prefix).
  Plaintext never hits the DB.
- `cron-worker/poster.js` — reads + decrypts that token to publish reels/carousels;
  auto-refreshes any token within 7 days of expiry (`refreshExpiringTokens`).

Before advanced access, `instagram_content_publish` worked only for the app's own
test users. The same unchanged code now works for any connected creator.

---

## Pending — NOT in this repo

### Desktop repo (`BrandGita`, Electron) — mechanical wiring
`scripts/check_ipc_map.js` fails the build until all ends agree.

1. `electron-shell/igcloud.js` — add two methods alongside
   `createSchedule`/`listSchedule`/`cancelSchedule`:
   - `updateSchedule(id, patch)` → `PATCH /api/schedule/{id}`
   - `checkConnection()` → `GET /api/connection`
2. `electron-shell/ipc-channels.js` — declare `igUpdateSchedule` and
   `igCheckConnection`.
3. `electron-shell/main.js` **and** `electron-shell/preload.js` — handler + exposure,
   **and** add both channels to preload's inlined sandbox-safe `IPC` mirror.
4. Call `checkConnection()` in the pre-schedule flow and surface `reason` to the user.

### Ops (founder-required)
- Confirm Cloudflare **production secrets** are set: `TOKEN_ENC_KEY`,
  `IG_CLIENT_SECRET`, `IG_CLIENT_ID`, `IG_REDIRECT_URI`, `API_SECRET`.
- One **live creator dry-run**: connect a real account, schedule one reel, let the
  cron publish it. (CLAUDE.md founder blocker — can't be done autonomously.)

---

## Out of scope (deliberately not built)

- **Bulk delete** — foot-gun on a live calendar; N ≤ 30 is a trivial client loop with
  visible partial-failure (spec §"What is deliberately NOT proposed").
- **General `PUT`** — full-replacement reintroduces the media-swap problem PATCH avoids.

## Minor cleanup for later

- Graph API version drift: `connection.js` + `token.js` use `v22.0`; `poster.js` uses
  `v21.0`. Harmless today; align to one version in a future pass.

## Not touched

Unrelated pre-existing working-tree changes (`functions/api/token.js` mods,
`premium.html`, `public/fonts/`, `src/premium/`) were left uncommitted — not part of
this feature.
