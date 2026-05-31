/**
 * GET /admin/funnel
 * Returns funnel drop-off summary + avg time per step from funnel_events.
 * Protected by HTTP Basic Auth (same EXPORT_SECRET as /admin/export).
 * The dashboard's internal call passes the SAME Basic Auth header — the secret
 * is never put in the query string (query strings leak into logs/history/Referer).
 *
 * Optional query param: ?range=day|week|month|all  (default: all)
 * Filters funnel_events to sessions whose events fall within the window.
 */
import { requireAuth } from './_auth.js'

// Map whitelisted range values to fixed SQL date fragments.
// The fragment is a complete SQL predicate appended with AND, or empty string for 'all'.
// NEVER interpolate raw user input — only these four constants reach the query.
const RANGE_FILTER = {
  day:   `AND ts >= datetime('now','-1 day')`,
  week:  `AND ts >= datetime('now','-7 days')`,
  month: `AND ts >= datetime('now','-30 days')`,
  all:   '',
}

export async function onRequest(context) {
  const { request, env } = context;

  const unauth = requireAuth(request, env)
  if (unauth) return unauth

  // Validate range param — reject anything outside the whitelist.
  const reqUrl = new URL(request.url)
  const rangeParam = reqUrl.searchParams.get('range') ?? 'all'
  if (!(rangeParam in RANGE_FILTER)) {
    return new Response(JSON.stringify({ error: 'Invalid range. Use day, week, month, or all.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const range = rangeParam
  const tsFilter = RANGE_FILTER[range]   // fixed SQL fragment, never raw user input

  // Last answer per step per session — ignores toggling.
  // Apply ts filter on both the outer row and the correlated MAX subquery so that
  // only events within the window are considered (consistent dedup within the window).
  const { results: stepCounts } = await env.DB.prepare(`
    SELECT step, COUNT(DISTINCT session_id) AS visitors
    FROM funnel_events f1
    WHERE ts = (
      SELECT MAX(ts) FROM funnel_events f2
      WHERE f2.session_id = f1.session_id AND f2.step = f1.step
      ${tsFilter}
    )
    ${tsFilter}
    GROUP BY step
    ORDER BY visitors DESC
  `).all()

  // Breakdown of what people selected per step (last answer only)
  const { results: breakdown } = await env.DB.prepare(`
    SELECT step, value, COUNT(DISTINCT session_id) AS count
    FROM funnel_events f1
    WHERE ts = (
      SELECT MAX(ts) FROM funnel_events f2
      WHERE f2.session_id = f1.session_id AND f2.step = f1.step
      ${tsFilter}
    )
    ${tsFilter}
    GROUP BY step, value
    ORDER BY step, count DESC
  `).all()

  // Avg seconds between first answer on step N and first answer on step N+1
  // Uses first-seen timestamp per (session, step) pair, within the selected window.
  const { results: timings } = await env.DB.prepare(`
    WITH first_seen AS (
      SELECT session_id, step, MIN(ts) AS ts
      FROM funnel_events
      WHERE 1=1 ${tsFilter}
      GROUP BY session_id, step
    )
    SELECT
      a.step,
      ROUND(AVG(
        (julianday(b.ts) - julianday(a.ts)) * 86400
      )) AS avg_seconds_to_next
    FROM first_seen a
    JOIN first_seen b
      ON a.session_id = b.session_id
    WHERE
      (a.step = 'role'      AND b.step = 'platform')  OR
      (a.step = 'platform'  AND b.step = 'monetise')  OR
      (a.step = 'monetise'  AND b.step = 'os')        OR
      (a.step = 'os'        AND b.step IN ('mac','windows')) OR
      (a.step = 'mac'       AND b.step = 'ram')       OR
      (a.step = 'windows'   AND b.step = 'ram')       OR
      (a.step = 'ram'       AND b.step = 'ai')        OR
      (a.step = 'ai'        AND b.step = 'submitted')
    GROUP BY a.step
  `).all()

  // Total unique sessions within the selected window
  const { results: [{ total }] } = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS total FROM funnel_events WHERE 1=1 ${tsFilter}`
  ).all()

  // Index lookups
  const byStep = {}
  for (const row of breakdown) {
    if (!byStep[row.step]) byStep[row.step] = []
    byStep[row.step].push({ value: row.value, count: row.count })
  }
  const timingByStep = {}
  for (const row of timings) {
    timingByStep[row.step] = row.avg_seconds_to_next
  }

  const STEP_ORDER = ['role', 'platform', 'monetise', 'os', 'mac', 'windows', 'ram', 'ai', 'submitted']
  const summary = STEP_ORDER
    .map(step => {
      const row = stepCounts.find(r => r.step === step)
      return {
        step,
        visitors: row ? row.visitors : 0,
        avg_seconds_on_step: timingByStep[step] ?? null,
        breakdown: byStep[step] || [],
      }
    })
    .filter(s => s.visitors > 0)

  return new Response(JSON.stringify({ range, total_sessions: total, funnel: summary }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
