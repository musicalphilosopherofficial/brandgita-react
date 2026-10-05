/**
 * Raise a permanently failed post into the bug_reports queue.
 *
 * That queue is the existing audit-and-ticket pathway: cron-worker/bugdrain.js turns every pending
 * row into a Notion page and a GitHub issue. A post that exhausted its retries is exactly the
 * thing the founder must see, so it goes through the same door rather than a second channel.
 *
 * Idempotent: the report id is derived from the post id, and the insert is INSERT OR IGNORE, so a
 * post that fails repeatedly produces one ticket, not one per attempt.
 *
 * NEVER THROWS. This runs on the failure path of publishing; an audit-write problem must not turn
 * into a second failure or mask the first.
 *
 * `diagnostics.source = 'system'` is what bugdrain keys on to label the GitHub issue
 * `system-alert` so the alerting routine can find it. The error text sits under
 * `untrusted_user_input` because it comes from a third party (Instagram's API) and lands verbatim
 * in an issue body that automated triage may later read — the same boundary bugreport.js draws.
 */

async function reportId(postId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`post-failure:${postId}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `bg-${hex.slice(0, 16)}`;
}

export async function raisePostFailure(env, post, errorText) {
  try {
    let membership = null;
    try {
      const row = await env.DB.prepare(
        `SELECT whop_membership_id FROM ig_tokens WHERE ig_user_id = ?`
      ).bind(post.ig_user_id).first();
      membership = row?.whop_membership_id ?? null;
    } catch (err) {
      console.error('failure-audit: membership lookup failed', { message: err?.message });
    }

    const summary =
      `Scheduled ${post.type} post ${post.id} failed permanently after ${post.retry_count ?? '?'} attempts: ` +
      String(errorText || 'unknown error').slice(0, 400);

    const payload = JSON.stringify({
      untrusted_user_input: { summary, transcript_raw: '', steps_to_reproduce: '', expected: '' },
      diagnostics: {
        source: 'system',
        kind: 'post_failure',
        post_id: post.id,
        platform: post.platform || 'ig',
        post_type: post.type,
        post_at: post.post_at,
        retry_count: post.retry_count ?? null,
      },
    });

    await env.DB.prepare(
      `INSERT OR IGNORE INTO bug_reports (report_id, membership_id, report_type, payload, status, created_at)
       VALUES (?, ?, 'bug', ?, 'pending', datetime('now'))`
    ).bind(await reportId(post.id), membership || 'system', payload).run();
  } catch (err) {
    console.error('failure-audit: could not raise the report', { message: err?.message });
  }
}
