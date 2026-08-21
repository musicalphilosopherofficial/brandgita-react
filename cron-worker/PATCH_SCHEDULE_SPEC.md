# Spec — `PATCH /api/schedule/{id}` (reschedule without re-uploading)

**Status:** ✅ built (server side) — `PATCH` handler in `functions/api/schedule/[id].js`,
tests in `functions/api/schedule.patch.test.js` (13 cases, all green). Desktop-side edits
below are still pending in the `BrandGita` repo. · **Written:** 2026-08-21 · **For:** whoever picks this repo up next
**Companion to:** `DESKTOP_HANDOFF.md` (which documents the endpoints that already exist)

---

## The problem, precisely

The live API supports **create / list / cancel** and nothing else. Verified against source,
not the handoff doc:

| Route | File | Methods actually handled |
|---|---|---|
| `/api/schedule` | `functions/api/schedule.js` | `OPTIONS`, `POST`, `GET` |
| `/api/schedule/{id}` | `functions/api/schedule/[id].js` | `OPTIONS`, `DELETE` |

So **moving a post to a different day is `DELETE` + `POST`.** That is not merely
inelegant — it is expensive, for one specific reason:

- `[id].js:92` — cancelling **deletes the post's media from R2**:
  `await env.SCHEDULE_BUCKET.delete(key)` for every `asset_keys` entry plus `cover_key`.
- `schedule.js` (POST) **requires `asset_keys` that already exist in R2**:
  `if (!id || !type || !Array.isArray(asset_keys) || asset_keys.length === 0 …) → 400`.

Net effect: **changing a timestamp forces a full re-upload of the reel, or of every slide
in a carousel.** On a creator's upload connection that is tens of megabytes to move a post
by one day.

### What PATCH is and is NOT for

PATCH does **not** blank days. The three calendar actions are distinct:

| Action | Mechanism | Cost |
|---|---|---|
| Leave a day blank from the start | never create a post for it | free — no API call |
| Remove a post already scheduled | `DELETE /{id}` | real removal: also deletes its R2 media |
| **Move a post to another day** | today `DELETE`+`POST` | **full media re-upload** |

PATCH exists for the third row only.

### Why that matters to the product, not just to the API

The desktop workflow is: generate ~14–30 days of content from a pillar idea, schedule it,
then **deliberately blank out some days** for door-knob reels, stories and lives — the
authenticity days that must not be auto-filled. Rearranging the calendar is therefore a
routine action, not an edge case. If every drag costs a re-upload, creators will stop
rearranging, and the "leave real days open" habit quietly dies.

**The cascade is the real cost.** Blanking a day is rarely just "delete that post" — the
creator wants to *keep* the content and slide it. Freeing Wednesday means Wednesday's
carousel moves to Thursday, Thursday's to Friday, and so on to the end of the run. With
only DELETE+POST available, blanking ONE day in a 14-day schedule can mean re-uploading a
dozen posts' media. With PATCH it is a dozen timestamp writes and zero bytes transferred.

That is why the endpoint is worth building even though a workaround technically exists:
the workaround's cost scales with how much content the creator has queued, which is
exactly the number the product is trying to make large.

---

## What to build

`PATCH /api/schedule/{id}` — a **narrow** patch, in the same file as `DELETE`
(`functions/api/schedule/[id].js`).

### Accepts

```jsonc
{ "post_at": "2026-09-03T09:00:00Z" }   // required
{ "caption": "new caption text" }        // optional, same rules as POST
```

### Explicitly REJECTS (400)

`asset_keys`, `type`, `cover_key`, `id`, `ig_user_id`, or any unknown key.

Rationale: swapping the media is genuinely a *different post*. Allowing it in-place
produces a row whose id no longer means what it meant when the cron worker validated it,
and the retry logic would then operate on content it never checked. Rejecting unknown keys
outright (rather than ignoring them) turns a client-side typo into a visible 400 instead of
a silent no-op.

### Guards — mirror `DELETE`'s existing ones exactly

1. **Auth:** `Authorization: Bearer <desktop_token>` → resolve to `ig_user_id`.
2. **Ownership:** if `post.ig_user_id !== ig_user_id` → **404, not 403** (`[id].js:56`
   already does this deliberately, so as not to leak that a post exists).
3. **Status:** only `post.status === 'scheduled'` may be patched. Anything already
   `posting` / `posted` / `failed` → 409 with
   `Cannot reschedule a post that is already ${post.status}`.
   *A post mid-flight must not have its time changed under the cron worker.*
4. **`post_at` must be in the future** at the moment of the call. Scheduling into the past
   queues something that can never fire; refuse rather than accept silently.
5. **Horizon:** reject `post_at` further ahead than the allowed window. The desktop side
   already owns this policy — `brand_gita_core/tiers.py::TierPolicy.can_schedule()`, 30
   days initially, rising to 45 on >2 months tenure later. The server should enforce its
   own bound too rather than trusting the client; the server bound is **45 days** (the
   tenured allowance — chosen over the 30-day baseline so reschedules aren't blocked
   before the desktop tier catches up).

### Returns

`{ ok: true, id, post_at, caption }` · errors as `{ ok: false, error }` per house style.

### Does NOT touch R2

The whole point. One D1 `UPDATE`, no `SCHEDULE_BUCKET` calls.

---

## Tests

Follow `functions/api/token.test.js`: ESM, `node --test`, built-in runner, **no new deps**,
fake D1 + mocked `fetch`. Run: `node --test functions/api/schedule.patch.test.js`

Cases worth pinning:

- moves `post_at`, returns `ok:true`, and **makes zero `SCHEDULE_BUCKET` calls**
  (assert on a fake bucket that records every call — this is the regression that matters)
- another user's post → **404**, and the body must not reveal it exists
- `status: 'posted'` → 409, row unchanged
- `status: 'posting'` → 409 (the mid-flight case)
- `post_at` in the past → 400
- `post_at` beyond the 45-day horizon → 400
- body containing `asset_keys` → 400, row unchanged
- unknown key in body → 400
- `caption` over 2200 chars → 400 (same bound POST enforces)
- absent id → 404

---

## Desktop side (the other repo — `BrandGita`)

Not required for this repo to ship, listed so the contract is understood end to end.
Three edits, all mechanical, and a drift gate enforces that they stay in sync:

1. `electron-shell/igcloud.js` — add alongside `createSchedule` / `listSchedule` /
   `cancelSchedule`:
   ```js
   // PATCH /api/schedule/{id} → { ok, id, post_at, caption }
   updateSchedule: (id, patch) =>
     authed(`/api/schedule/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
   ```
2. `electron-shell/ipc-channels.js` — declare `igUpdateSchedule`.
3. `electron-shell/main.js` **and** `electron-shell/preload.js` — handler + exposure, and
   **also** add the channel to preload's inlined sandbox-safe `IPC` mirror.
   `scripts/check_ipc_map.js` fails the build until all ends agree; it specifically caught
   the missing mirror entry when `generateCarousel` was added, which is what it exists for.

---

## What is deliberately NOT proposed

**Bulk delete.** A "clear these N days" endpoint is a foot-gun on a live posting calendar,
and N ≤ 30 is a trivial client loop. Looping also gives partial, visible failure instead of
one irreversible call. If the UI wants "clear this week", let it loop and show progress.

**A general-purpose `PUT`.** Full-replacement semantics reintroduce exactly the media-swap
problem the narrow `PATCH` is designed to avoid.
