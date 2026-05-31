/**
 * GET /admin/funnel
 * Returns funnel drop-off summary + avg time per step + a time-series ("trends")
 * dataset from funnel_events. Protected by HTTP Basic Auth (same EXPORT_SECRET as
 * /admin/export). The dashboard's internal call passes the SAME Basic Auth header
 * — the secret is never put in the query string.
 *
 * Optional query param:
 *   ?range=day|week|month|quarter|halfyear|year|all   (default: all)
 */
import { requireAuth } from './_auth.js'

// Whitelisted ranges → fixed SQL date predicates (appended with AND). NEVER
// interpolate raw user input — only these constants reach the query.
const RANGE_FILTER = {
  day:      `AND ts >= datetime('now','-1 day')`,
  week:     `AND ts >= datetime('now','-7 days')`,
  month:    `AND ts >= datetime('now','-30 days')`,
  quarter:  `AND ts >= datetime('now','-90 days')`,
  halfyear: `AND ts >= datetime('now','-180 days')`,
  year:     `AND ts >= datetime('now','-365 days')`,
  all:      '',
}

// Time-series bucket granularity per range (also fixed constants, never raw input).
const RANGE_BUCKET = {
  day:      `strftime('%m-%d %Hh', ts)`,   // hourly
  week:     `date(ts)`,                     // daily
  month:    `date(ts)`,                     // daily
  quarter:  `strftime('%Y-W%W', ts)`,       // weekly
  halfyear: `strftime('%Y-W%W', ts)`,       // weekly
  year:     `strftime('%Y-%m', ts)`,        // monthly
  all:      `strftime('%Y-%m', ts)`,        // monthly
}

export async function onRequest(context) {
  const { request, env } = context;

  const unauth = requireAuth(request, env)
  if (unauth) return unauth

  const reqUrl = new URL(request.url)
  const rangeParam = reqUrl.searchParams.get('range') ?? 'all'
  if (!(rangeParam in RANGE_FILTER)) {
    return new Response(JSON.stringify({ error: 'Invalid range.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
  const range = rangeParam
  const tsFilter = RANGE_FILTER[range]      // fixed SQL fragment
  const bucketExpr = RANGE_BUCKET[range]    // fixed SQL fragment

  // Last answer per step per session — ignores toggling. ts filter on both the
  // outer row and the correlated MAX subquery keeps dedup consistent within window.
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

  // Avg seconds between first answer on step N and first answer on step N+1.
  const { results: timings } = await env.DB.prepare(`
    WITH first_seen AS (
      SELECT session_id, step, MIN(ts) AS ts
      FROM funnel_events
      WHERE 1=1 ${tsFilter}
      GROUP BY session_id, step
    )
    SELECT
      a.step,
      ROUND(AVG((julianday(b.ts) - julianday(a.ts)) * 86400)) AS avg_seconds_to_next
    FROM first_seen a
    JOIN first_seen b ON a.session_id = b.session_id
    WHERE
      (a.step = 'region'    AND b.step = 'role')      OR
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

  const { results: [{ total }] } = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS total FROM funnel_events WHERE 1=1 ${tsFilter}`
  ).all()

  // Time-series: sessions started + submissions per time bucket within the window.
  const { results: series } = await env.DB.prepare(`
    SELECT
      ${bucketExpr} AS bucket,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT CASE WHEN step = 'submitted' THEN session_id END) AS submissions
    FROM funnel_events
    WHERE 1=1 ${tsFilter}
    GROUP BY bucket
    ORDER BY bucket
  `).all()

  // Index lookups
  const byStep = {}
  for (const row of breakdown) {
    if (!byStep[row.step]) byStep[row.step] = []
    byStep[row.step].push({ value: row.value, count: row.count })
  }
  const timingByStep = {}
  for (const row of timings) timingByStep[row.step] = row.avg_seconds_to_next

  // region is the FIRST step now — must lead the funnel order.
  const STEP_ORDER = ['region', 'role', 'platform', 'monetise', 'os', 'mac', 'windows', 'ram', 'ai', 'submitted']
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

  return new Response(JSON.stringify({ range, total_sessions: total, funnel: summary, series }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
