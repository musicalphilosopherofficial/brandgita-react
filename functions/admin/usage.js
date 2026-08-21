/**
 * GET /admin/usage — "how much is the app being used, and where".
 *
 * Basic Auth via _auth.js (username admin, password EXPORT_SECRET), same as the funnel
 * dashboard. Query: ?days=7|30|90|all (default 30).
 *
 * Three questions, in the order they are actually asked:
 *   1. THE LADDER  — where do people stop? activated → onboarded → rendered → published.
 *   2. WHO         — per-creator scorecard, ranked by how far up the ladder they got.
 *   3. WHAT        — feature adoption, so a dead surface is visible rather than assumed.
 *
 * Every row here originates from an UNAUTHENTICATED ingest endpoint, so every value is
 * escaped before it reaches HTML. The ingest already allowlists, but a dashboard that
 * trusts its own database is one bug away from executing an attacker's payload in the
 * founder's authenticated session.
 */
import { requireAuth } from './_auth.js'

const LADDER = [
  ['app_activated', 'Activated', 'opened the app'],
  ['onboarding_completed', 'Onboarded', 'finished the interview'],
  ['pipeline_started', 'Started', 'ran the core loop'],
  ['render_completed', 'Rendered', 'got an artifact'],
  ['published', 'Published', 'shipped it'],
]

export async function onRequest(context) {
  const { request, env } = context
  const unauth = requireAuth(request, env)
  if (unauth) return unauth

  const url = new URL(request.url)
  const daysParam = url.searchParams.get('days') ?? '30'
  const days = ['7', '30', '90', 'all'].includes(daysParam) ? daysParam : '30'
  const since = days === 'all' ? "'1970-01-01'" : `datetime('now','-${days} days')`

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const q = async (sql) => {
    try {
      const r = await env.DB.prepare(sql).all()
      return r.results || []
    } catch (err) {
      console.error('usage dashboard query failed:', { message: err?.message })
      return null
    }
  }

  // Distinct creators per ladder rung — the funnel.
  const rungs = await q(
    `SELECT event, COUNT(DISTINCT license_hash) AS people, COUNT(*) AS events
     FROM usage_events WHERE created_at >= ${since} GROUP BY event`
  )
  // Per-creator scorecard.
  const people = await q(
    `SELECT license_hash,
            COUNT(*) AS events,
            COUNT(DISTINCT date(created_at)) AS active_days,
            MAX(created_at) AS last_seen,
            SUM(CASE WHEN event='render_completed' THEN 1 ELSE 0 END) AS renders,
            SUM(CASE WHEN event='published' THEN 1 ELSE 0 END) AS publishes,
            SUM(CASE WHEN event='publish_failed' THEN 1 ELSE 0 END) AS publish_failures
     FROM usage_events WHERE created_at >= ${since}
     GROUP BY license_hash ORDER BY publishes DESC, renders DESC, last_seen DESC LIMIT 200`
  )
  // Which surfaces earn their keep.
  const features = await q(
    `SELECT json_extract(props,'$.feature') AS feature,
            COUNT(DISTINCT license_hash) AS people, COUNT(*) AS uses
     FROM usage_events
     WHERE event='feature_used' AND created_at >= ${since}
       AND json_extract(props,'$.feature') IS NOT NULL
     GROUP BY feature ORDER BY people DESC, uses DESC`
  )
  // Where the pipeline loses people.
  const abandons = await q(
    `SELECT json_extract(props,'$.last_phase') AS phase, COUNT(*) AS n
     FROM usage_events WHERE event='render_abandoned' AND created_at >= ${since}
       AND json_extract(props,'$.last_phase') IS NOT NULL
     GROUP BY phase ORDER BY n DESC`
  )

  const failed = rungs === null || people === null
  const byEvent = Object.fromEntries((rungs || []).map((r) => [r.event, r]))
  const top = byEvent['app_activated']?.people || 0
  const totalEvents = (rungs || []).reduce((a, r) => a + r.events, 0)

  const pct = (n) => (top ? Math.round((n / top) * 100) : 0)

  const ladderRows = LADDER.map(([ev, label, blurb]) => {
    const n = byEvent[ev]?.people || 0
    return `<tr>
      <td><strong>${esc(label)}</strong><span class="sub">${esc(blurb)}</span></td>
      <td class="num">${n}</td>
      <td class="bar"><span style="width:${pct(n)}%"></span></td>
      <td class="num dim">${pct(n)}%</td>
    </tr>`
  }).join('')

  const dropoff = (() => {
    // The biggest single fall between adjacent rungs is the thing to fix first.
    let worst = null
    for (let i = 1; i < LADDER.length; i++) {
      const a = byEvent[LADDER[i - 1][0]]?.people || 0
      const b = byEvent[LADDER[i][0]]?.people || 0
      if (a > 0 && (worst === null || a - b > worst.lost)) {
        worst = { from: LADDER[i - 1][1], to: LADDER[i][1], lost: a - b, rate: Math.round(((a - b) / a) * 100) }
      }
    }
    return worst
  })()

  const peopleRows = (people || []).map((p) => `<tr>
      <td class="mono">${esc(String(p.license_hash).slice(0, 12))}…</td>
      <td class="num">${p.active_days}</td>
      <td class="num">${p.renders}</td>
      <td class="num">${p.publishes}</td>
      <td class="num ${p.publish_failures > 0 ? 'bad' : 'dim'}">${p.publish_failures}</td>
      <td class="num dim">${p.events}</td>
      <td class="dim">${esc(p.last_seen)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No creators yet.</td></tr>'

  const featTop = (features || [])[0]?.people || 1
  const featureRows = (features || []).map((f) => `<tr>
      <td>${esc(f.feature)}</td>
      <td class="num">${f.people}</td>
      <td class="bar"><span style="width:${Math.round((f.people / featTop) * 100)}%"></span></td>
      <td class="num dim">${f.uses}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">No feature_used events yet.</td></tr>'

  const abandonRows = (abandons || []).map((a) =>
    `<tr><td>${esc(a.phase)}</td><td class="num">${a.n}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="empty">No abandoned renders. Good.</td></tr>'

  const tab = (d, label) =>
    `<a href="?days=${d}" class="${days === d ? 'on' : ''}">${label}</a>`

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Usage — Brand Gita</title>
<style>
  :root{--bg:#0f1113;--card:#16191c;--ink:#e8e6e1;--dim:#8b9096;--line:#24282c;--accent:#d98b4a;--bad:#c76b6b}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px;background:var(--bg);color:var(--ink);
       font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
  .wrap{max-width:980px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .lede{color:var(--dim);margin:0 0 24px;font-size:14px}
  .tabs{display:flex;gap:6px;margin-bottom:24px;flex-wrap:wrap}
  .tabs a{padding:5px 12px;border:1px solid var(--line);border-radius:999px;
          color:var(--dim);text-decoration:none;font-size:13px}
  .tabs a.on{background:var(--accent);border-color:var(--accent);color:#17140f;font-weight:600}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;
        padding:18px 20px;margin-bottom:18px;overflow-x:auto}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
     margin:0 0 14px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid var(--line);font-size:14px}
  th{color:var(--dim);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;width:1%;white-space:nowrap}
  .dim{color:var(--dim)} .bad{color:var(--bad)} .mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}
  .sub{display:block;color:var(--dim);font-size:12px;font-weight:400}
  .bar{width:45%}
  .bar span{display:block;height:7px;border-radius:4px;background:var(--accent);min-width:2px}
  .empty{color:var(--dim);text-align:center;padding:20px 0}
  .note{background:#1b1508;border:1px solid #3d2f14;color:#e0c48f;padding:12px 14px;
        border-radius:8px;font-size:13.5px;margin-bottom:18px}
  .err{background:#231414;border-color:#4a2626;color:#e7a9a9}
  footer{color:var(--dim);font-size:12px;margin-top:26px;line-height:1.7}
</style></head><body><div class="wrap">
  <h1>Usage</h1>
  <p class="lede">How much the app is being used, and where people stop.</p>
  <div class="tabs">${tab('7', '7 days')}${tab('30', '30 days')}${tab('90', '90 days')}${tab('all', 'All time')}</div>

  ${failed ? '<div class="note err">A query failed — figures below may be incomplete. Check the Worker logs.</div>' : ''}
  ${totalEvents === 0 && !failed ? `<div class="note"><strong>No events yet.</strong> The table is live and the endpoint is
    accepting writes; nothing has sent one. Usage only flows when a creator is on a trial licence, or on paid
    <em>with</em> consent — so an empty board here is the expected state before the first real session.</div>` : ''}

  <div class="card">
    <h2>The ladder — where people stop</h2>
    <table><thead><tr><th>Rung</th><th class="num">People</th><th></th><th class="num">of activated</th></tr></thead>
    <tbody>${ladderRows}</tbody></table>
    ${dropoff && dropoff.lost > 0 ? `<p class="lede" style="margin:14px 0 0">Biggest fall:
      <strong>${esc(dropoff.from)} → ${esc(dropoff.to)}</strong>, losing ${dropoff.lost}
      (${dropoff.rate}%). Fix that step first.</p>` : ''}
  </div>

  <div class="card">
    <h2>Creators</h2>
    <table><thead><tr><th>Licence</th><th class="num">Active days</th><th class="num">Renders</th>
      <th class="num">Publishes</th><th class="num">Failed</th><th class="num">Events</th><th>Last seen</th></tr></thead>
    <tbody>${peopleRows}</tbody></table>
  </div>

  <div class="card">
    <h2>Feature adoption</h2>
    <table><thead><tr><th>Feature</th><th class="num">People</th><th></th><th class="num">Uses</th></tr></thead>
    <tbody>${featureRows}</tbody></table>
  </div>

  <div class="card">
    <h2>Where renders are abandoned</h2>
    <table><thead><tr><th>Last phase</th><th class="num">Count</th></tr></thead>
    <tbody>${abandonRows}</tbody></table>
  </div>

  <footer>
    Licences are one-way SHA-256 hashes — there is no way back to a person from this page.<br>
    No footage, filenames, transcripts or captions are stored: the ingest allowlists props per event.
  </footer>
</div></body></html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
