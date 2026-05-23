/**
 * GET /admin/export?secret=YOUR_EXPORT_SECRET
 * Returns the full waitlist as CSV.
 * Set EXPORT_SECRET in Cloudflare Pages → Settings → Environment Variables.
 */
export async function onRequest(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');

  if (!secret || secret !== env.EXPORT_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, hardware, created_at FROM waitlist ORDER BY created_at DESC`
  ).all();

  const header = 'id,email,name,hardware,created_at\n';
  const rows = results
    .map(r =>
      [r.id, r.email, r.name ?? '', r.hardware ?? '', r.created_at]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\n');

  return new Response(header + rows, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="brandgita-waitlist.csv"',
    },
  });
}
