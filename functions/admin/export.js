/**
 * GET /admin/export
 * Returns the full waitlist as CSV. Protected by HTTP Basic Auth (same as the
 * other /admin routes). The secret is NEVER accepted in the query string —
 * query strings leak into access logs, browser history, and Referer headers,
 * and this endpoint dumps every applicant's name + email (full PII).
 */
import { requireAuth } from './_auth.js';

// Neutralise CSV/spreadsheet formula injection: a cell beginning with = + - @
// (or tab/CR) can execute when opened in Excel/Sheets. Prefix with a single quote.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function onRequest(context) {
  const { request, env } = context;

  const unauth = requireAuth(request, env);
  if (unauth) return unauth;

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, platform, monetise, hardware, region, confirmed, priority_score, intent_signal, intent_at, created_at
     FROM waitlist ORDER BY priority_score DESC, created_at ASC`
  ).all();

  const cols = ['id', 'email', 'name', 'role', 'platform', 'monetise', 'hardware', 'region', 'confirmed', 'priority_score', 'intent_signal', 'intent_at', 'created_at'];
  const header = cols.join(',') + '\n';
  const rows = results
    .map(r => cols.map(c => csvCell(r[c])).join(','))
    .join('\n');

  return new Response(header + rows, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="brandgita-waitlist.csv"',
    },
  });
}
