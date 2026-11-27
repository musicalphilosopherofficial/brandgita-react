# Instagram collaborator invites — contract

Scenarios: `features/instagram-collaborators.feature`. Rules: `shared/collaborators.js`.

## Requests

- `POST /api/schedule`: optional `"collaborators": ["name", "@other"]` on an Instagram **reel** or **carousel**.
- `PATCH /api/schedule/{id}`: `collaborators` sets or replaces; `[]` or `null` removes; omitted = unchanged. Only while `scheduled` (else `409`).
- `GET /api/schedule`: each post has `collaborators: string[] | null`.

At most 3; a leading `@` is stripped; repeats count once. `400` messages: `collaborators must be a list of usernames`,
`collaborators[<i>] must be a username: ...`, `a post can invite at most 3 collaborators`,
`collaborators only apply to: reel, carousel (this post is a story)`.

## Publishing

Sent as a JSON array on the reel container or the carousel **parent**. A post with collaborators is never published without them.

- Refusal (HTTP 4xx, not transient, with code 100/110 or a message naming collaborators): the row is `failed` at once with
  `Instagram would not accept this post with collaborators @a, @b. Nothing was posted. ... Instagram said: ...`
- Anything else retries as usual, still with the collaborators.

## Not verified

- Meta documents `collaborators` without saying whether Instagram Login (`graph.instagram.com`) accepts it. **Needs one real test post.**
- If Instagram silently ignores the parameter, the post goes out without invites and nothing here can detect it (invite status
  is readable through Facebook Login only).
- Meta documents no error for a refused invite; the refusal rule above is our reading, to be confirmed by real responses.

## Deploy order (each step needs the founder's go-ahead)

1. Apply `migrations/0027_scheduled_posts_collaborators.sql`.
2. Deploy the cron worker.
3. Push `main` (Pages). The schedule routes read the new column, so the migration must be first.
4. One test post; confirm the invite arrives.
5. PATCH the scheduled posts.
