/**
 * GET /admin/funnel
 * Returns funnel drop-off summary + avg time per step from funnel_events.
 * Protected by HTTP Basic Auth (same EXPORT_SECRET as /admin/export).
 * Also accepts ?secret= for internal server-to-server calls from dashboard.
 */
import { requireAuth } from './_auth.js'

export async function onRequest(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');

  // Allow internal calls via ?secret= (from dashboard worker-to-worker fetch)
  // otherwise require Basic Auth
  if (secret !== env.EXPORT_SECRET) {
    const unauth = requireAuth(request, env)
    if (unauth) return unauth
  }

  // Last answer per step per session — ignores toggling
  const { results: stepCounts } = await env.DB.prepare(`
    SELECT step, COUNT(DISTINCT session_id) AS visitors
    FROM funnel_events f1
    WHERE ts = (
      SELECT MAX(ts) FROM funnel_events f2
      WHERE f2.session_id = f1.session_id AND f2.step = f1.step
    )
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
    )
    GROUP BY step, value
    ORDER BY step, count DESC
  `).all()

  // Avg seconds between first answer on step N and first answer on step N+1
  // Uses first-seen timestamp per (session, step) pair
  const { results: timings } = await env.DB.prepare(`
    WITH first_seen AS (
      SELECT session_id, step, MIN(ts) AS ts
      FROM funnel_events
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

  // Total unique sessions ever seen
  const { results: [{ total }] } = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS total FROM funnel_events`
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

  return new Response(JSON.stringify({ total_sessions: total, funnel: summary }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
