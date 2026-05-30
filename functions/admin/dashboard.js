/**
 * GET /admin/dashboard
 * Visual funnel dashboard. Protected by HTTP Basic Auth.
 * Username: admin  Password: EXPORT_SECRET (set in Cloudflare Pages env vars)
 * Browser saves credentials after first login — no URL token needed.
 */
import { requireAuth } from './_auth.js'

export async function onRequest(context) {
  const { request, env } = context

  const unauth = requireAuth(request, env)
  if (unauth) return unauth

  const url = new URL(request.url)

  // Fetch funnel data internally using the env secret directly
  const funnelUrl = new URL('/admin/funnel', url.origin)
  funnelUrl.searchParams.set('secret', env.EXPORT_SECRET)
  const funnelRes = await fetch(funnelUrl.toString())
  const data = await funnelRes.json()

  const { total_sessions, funnel } = data
  const top = funnel[0]?.visitors || 1

  const STEP_LABELS = {
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

  function fmtTime(secs) {
    if (secs === null) return '—'
    if (secs < 60) return `${secs}s`
    return `${Math.floor(secs / 60)}m ${secs % 60}s`
  }

  function dropPct(current, prev) {
    if (!prev || prev === 0) return null
    const drop = Math.round((1 - current / prev) * 100)
    return drop > 0 ? drop : null
  }

  const rows = funnel.map((step, i) => {
    const pct = Math.round((step.visitors / top) * 100)
    const prev = i > 0 ? funnel[i - 1].visitors : null
    const drop = dropPct(step.visitors, prev)
    const label = STEP_LABELS[step.step] || step.step
    const breakdownHtml = step.breakdown.map(b => {
      const bPct = Math.round((b.count / step.visitors) * 100)
      return `<span class="tag">${b.value} <b>${bPct}%</b></span>`
    }).join('')

    return `
      <div class="row">
        <div class="meta">
          <span class="step-name">${label}</span>
          <span class="step-key">${step.step}</span>
        </div>
        <div class="bar-wrap">
          <div class="bar" style="width:${pct}%"></div>
        </div>
        <div class="stats">
          <span class="visitors">${step.visitors.toLocaleString()}</span>
          ${drop !== null ? `<span class="drop">↓ ${drop}% dropped</span>` : ''}
          ${step.avg_seconds_on_step !== null ? `<span class="time">⏱ ${fmtTime(step.avg_seconds_on_step)}</span>` : ''}
        </div>
        ${breakdownHtml ? `<div class="breakdown">${breakdownHtml}</div>` : ''}
      </div>`
  }).join('')

  const completionRate = top > 0
    ? Math.round(((funnel.find(s => s.step === 'submitted')?.visitors || 0) / total_sessions) * 100)
    : 0

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brand Gita — Waitlist Funnel</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F7F4EF; color: #1A1A18; padding: 2rem 1rem; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
  .subtitle { font-size: 0.85rem; color: #7A6F63; margin-bottom: 2rem; }
  .kpi-row { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .kpi { background: #fff; border: 1px solid #D4CFC4; border-radius: 10px; padding: 1rem 1.25rem; flex: 1; min-width: 120px; }
  .kpi-val { font-size: 2rem; font-weight: 800; color: #1A1A18; line-height: 1; }
  .kpi-label { font-size: 0.75rem; color: #7A6F63; margin-top: 0.3rem; }
  .funnel { background: #fff; border: 1px solid #D4CFC4; border-radius: 10px; padding: 1.5rem; }
  .row { padding: 0.9rem 0; border-bottom: 1px solid #EDE9E2; }
  .row:last-child { border-bottom: none; }
  .meta { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
  .step-name { font-size: 0.875rem; font-weight: 600; }
  .step-key { font-size: 0.72rem; color: #9B9789; font-family: monospace; }
  .bar-wrap { background: #F0EDE6; border-radius: 4px; height: 10px; margin-bottom: 0.45rem; }
  .bar { background: #2196F3; height: 10px; border-radius: 4px; transition: width 0.3s; min-width: 4px; }
  .stats { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; flex-wrap: wrap; }
  .visitors { font-weight: 700; font-size: 0.95rem; }
  .drop { color: #C0392B; font-weight: 600; }
  .time { color: #7A6F63; }
  .breakdown { margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .tag { font-size: 0.72rem; background: #F0EDE6; border: 1px solid #D4CFC4; border-radius: 4px; padding: 2px 7px; color: #4A4842; }
  .tag b { color: #1A1A18; }
  .refresh { font-size: 0.75rem; color: #9B9789; margin-top: 1.5rem; text-align: right; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Waitlist Funnel</h1>
  <p class="subtitle">Brand Gita · live data · <a href="/admin/dashboard" style="color:#2196F3">refresh</a></p>

  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-val">${total_sessions.toLocaleString()}</div>
      <div class="kpi-label">Total sessions started</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${funnel.find(s => s.step === 'submitted')?.visitors ?? 0}</div>
      <div class="kpi-label">Completed &amp; submitted</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${completionRate}%</div>
      <div class="kpi-label">Completion rate</div>
    </div>
  </div>

  <div class="funnel">
    ${rows}
  </div>

  <p class="refresh">⏱ = avg time before moving to the next step &nbsp;·&nbsp; ↓ = % who dropped after this step</p>
</div>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  })
}
