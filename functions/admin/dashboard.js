/**
 * GET /admin/dashboard
 * Visual funnel + trends dashboard. Protected by HTTP Basic Auth.
 * Username: admin  Password: EXPORT_SECRET (set in Cloudflare Pages env vars).
 *
 * Query params:
 *   ?range=day|week|month|quarter|halfyear|year|all   (default: all)
 *   ?view=funnel|trends                               (default: funnel)
 */
import { requireAuth } from './_auth.js'

export async function onRequest(context) {
  const { request, env } = context

  const unauth = requireAuth(request, env)
  if (unauth) return unauth

  const url = new URL(request.url)

  // Escape DB-sourced strings before HTML interpolation. funnel `value`s come from
  // the UNAUTHENTICATED /track endpoint — attacker-controlled → stored-XSS risk.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const VALID_RANGES = ['day', 'week', 'month', 'quarter', 'halfyear', 'year', 'all']
  const rangeParam = url.searchParams.get('range') ?? 'all'
  const range = VALID_RANGES.includes(rangeParam) ? rangeParam : 'all'

  const view = url.searchParams.get('view') === 'trends' ? 'trends' : 'funnel'

  // Fetch funnel data internally. Secret travels in the Basic Auth HEADER, never the URL.
  const funnelUrl = new URL('/admin/funnel', url.origin)
  funnelUrl.searchParams.set('range', range)
  const basic = 'Basic ' + btoa('admin:' + env.EXPORT_SECRET)
  const funnelRes = await fetch(funnelUrl.toString(), { headers: { Authorization: basic } })
  const data = await funnelRes.json()

  const { total_sessions, funnel, series = [] } = data
  const top = funnel[0]?.visitors || 1

  const STEP_LABELS = {
    region: 'Where are you based?',
    role: 'What describes you?',
    platform: 'Where do you publish?',
    monetise: 'Making money yet?',
    os: 'Operating system',
    mac: 'Mac model',
    windows: 'Windows setup',
    ram: 'RAM',
    ai: 'AI subscription',
    submitted: 'Submitted form',
  }

  const fmtTime = (secs) =>
    secs === null ? '—' : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`

  const dropPct = (current, prev) => {
    if (!prev || prev === 0) return null
    const drop = Math.round((1 - current / prev) * 100)
    return drop > 0 ? drop : null
  }

  // ── Funnel rows ────────────────────────────────────────────────────────────
  const rows = funnel.map((step, i) => {
    const pct = Math.round((step.visitors / top) * 100)
    const prev = i > 0 ? funnel[i - 1].visitors : null
    const drop = dropPct(step.visitors, prev)
    const label = STEP_LABELS[step.step] || esc(step.step)
    const breakdownHtml = step.step === 'submitted' ? '' : step.breakdown.map(b => {
      const bPct = Math.round((b.count / step.visitors) * 100)
      return `<span class="tag">${esc(b.value)} <b>${bPct}%</b></span>`
    }).join('')
    return `
      <div class="row">
        <div class="meta"><span class="step-name">${label}</span><span class="step-key">${esc(step.step)}</span></div>
        <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
        <div class="stats">
          <span class="visitors">${step.visitors.toLocaleString()}</span>
          ${drop !== null ? `<span class="drop">↓ ${drop}% dropped</span>` : ''}
          ${step.avg_seconds_on_step !== null ? `<span class="time">⏱ ${fmtTime(step.avg_seconds_on_step)}</span>` : ''}
        </div>
        ${breakdownHtml ? `<div class="breakdown">${breakdownHtml}</div>` : ''}
      </div>`
  }).join('')

  // ── Trends chart (pure CSS bars; CSP blocks scripts) ───────────────────────
  const maxSessions = series.reduce((m, p) => Math.max(m, p.sessions), 1)
  const labelEvery = Math.max(1, Math.ceil(series.length / 12))
  const chartCols = series.map((p, i) => {
    const sH = Math.round((p.sessions / maxSessions) * 150)
    const subH = Math.round((p.submissions / maxSessions) * 150)
    const showLabel = i % labelEvery === 0
    return `
      <div class="col" title="${esc(p.bucket)} — ${p.sessions} sessions, ${p.submissions} submitted">
        <div class="track">
          <div class="b-sessions" style="height:${sH}px"></div>
          <div class="b-sub" style="height:${subH}px"></div>
        </div>
        <div class="lbl">${showLabel ? esc(p.bucket) : ''}</div>
      </div>`
  }).join('')
  const trendsHtml = series.length === 0
    ? `<div class="empty">No data in this window yet.</div>`
    : `<div class="chart">${chartCols}</div>
       <div class="legend"><span class="key"><i class="sw sw-s"></i>Sessions started</span><span class="key"><i class="sw sw-sub"></i>Submitted</span></div>`

  const completionRate = total_sessions > 0
    ? Math.round(((funnel.find(s => s.step === 'submitted')?.visitors || 0) / total_sessions) * 100)
    : 0

  const RANGE_LABELS = { day: 'Today', week: '7 days', month: '30 days', quarter: '3 months', halfyear: '6 months', year: '1 year', all: 'All time' }
  const rangeLabel = RANGE_LABELS[range]
  const q = (r, v) => `/admin/dashboard?range=${r}&view=${v}`
  const rangeNav = VALID_RANGES.map(r =>
    `<a href="${q(r, view)}" class="${r === range ? 'active' : ''}">${RANGE_LABELS[r]}</a>`).join('')
  const viewNav = [['funnel', 'Funnel'], ['trends', 'Trends']].map(([v, lbl]) =>
    `<a href="${q(range, v)}" class="${v === view ? 'active' : ''}">${lbl}</a>`).join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brand Gita — Waitlist Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F7F4EF; color: #1A1A18; padding: 2rem 1rem; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
  .subtitle { font-size: 0.85rem; color: #7A6F63; margin-bottom: 1.25rem; }
  .navs { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.75rem; }
  .seg { display: flex; border: 1px solid #D4CFC4; border-radius: 8px; overflow: hidden; width: fit-content; }
  .seg a { display: inline-block; padding: 0.45rem 0.9rem; font-size: 0.8rem; font-weight: 500; color: #4A4842; text-decoration: none; background: #fff; border-right: 1px solid #D4CFC4; }
  .seg a:last-child { border-right: none; }
  .seg a:hover { background: #F0EDE6; }
  .seg a.active { background: #2196F3; color: #fff; font-weight: 700; }
  .kpi-row { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .kpi { background: #fff; border: 1px solid #D4CFC4; border-radius: 10px; padding: 1rem 1.25rem; flex: 1; min-width: 120px; }
  .kpi-val { font-size: 2rem; font-weight: 800; line-height: 1; }
  .kpi-label { font-size: 0.75rem; color: #7A6F63; margin-top: 0.3rem; }
  .panel { background: #fff; border: 1px solid #D4CFC4; border-radius: 10px; padding: 1.5rem; }
  .row { padding: 0.9rem 0; border-bottom: 1px solid #EDE9E2; }
  .row:last-child { border-bottom: none; }
  .meta { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
  .step-name { font-size: 0.875rem; font-weight: 600; }
  .step-key { font-size: 0.72rem; color: #9B9789; font-family: monospace; }
  .bar-wrap { background: #F0EDE6; border-radius: 4px; height: 10px; margin-bottom: 0.45rem; }
  .bar { background: #2196F3; height: 10px; border-radius: 4px; min-width: 4px; }
  .stats { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; flex-wrap: wrap; }
  .visitors { font-weight: 700; font-size: 0.95rem; }
  .drop { color: #C0392B; font-weight: 600; }
  .time { color: #7A6F63; }
  .breakdown { margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .tag { font-size: 0.72rem; background: #F0EDE6; border: 1px solid #D4CFC4; border-radius: 4px; padding: 2px 7px; color: #4A4842; }
  .tag b { color: #1A1A18; }
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 190px; padding-top: 10px; }
  .col { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 0; }
  .track { width: 100%; height: 150px; position: relative; display: flex; justify-content: center; }
  .b-sessions { width: 80%; background: #BBD9F5; border-radius: 3px 3px 0 0; position: absolute; bottom: 0; }
  .b-sub { width: 80%; background: #2196F3; border-radius: 3px 3px 0 0; position: absolute; bottom: 0; }
  .lbl { font-size: 9px; color: #9B9789; margin-top: 6px; white-space: nowrap; overflow: hidden; max-width: 100%; text-overflow: ellipsis; }
  .legend { display: flex; gap: 1rem; margin-top: 1rem; font-size: 0.75rem; color: #7A6F63; }
  .key { display: flex; align-items: center; gap: 0.35rem; }
  .sw { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .sw-s { background: #BBD9F5; } .sw-sub { background: #2196F3; }
  .empty { color: #9B9789; font-size: 0.85rem; text-align: center; padding: 2rem 0; }
  .foot { font-size: 0.75rem; color: #9B9789; margin-top: 1.5rem; text-align: right; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Waitlist Dashboard</h1>
  <p class="subtitle">Brand Gita · ${rangeLabel} · <a href="${q(range, view)}" style="color:#2196F3">refresh</a></p>

  <div class="navs">
    <nav class="seg">${viewNav}</nav>
    <nav class="seg">${rangeNav}</nav>
  </div>

  <div class="kpi-row">
    <div class="kpi"><div class="kpi-val">${total_sessions.toLocaleString()}</div><div class="kpi-label">Sessions started · ${rangeLabel}</div></div>
    <div class="kpi"><div class="kpi-val">${funnel.find(s => s.step === 'submitted')?.visitors ?? 0}</div><div class="kpi-label">Completed &amp; submitted</div></div>
    <div class="kpi"><div class="kpi-val">${completionRate}%</div><div class="kpi-label">Completion rate</div></div>
  </div>

  <div class="panel">
    ${view === 'trends' ? trendsHtml : rows}
  </div>

  ${view === 'funnel'
    ? `<p class="foot">⏱ = avg time before moving to the next step &nbsp;·&nbsp; ↓ = % who dropped after this step</p>`
    : `<p class="foot">Each bar = one ${range === 'day' ? 'hour' : (range === 'quarter' || range === 'halfyear') ? 'week' : (range === 'year' || range === 'all') ? 'month' : 'day'} in the window.</p>`}
</div>
</body>
</html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
