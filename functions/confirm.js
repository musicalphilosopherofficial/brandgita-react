/**
 * GET /confirm?token=<uuid>
 * Marks the applicant as confirmed in D1 and returns a success page.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return htmlPage('Invalid link', 'This confirmation link is missing a token. Please check your email and try again.');
  }

  const row = await env.DB.prepare(
    `SELECT id, confirmed FROM waitlist WHERE confirm_token = ?`
  ).bind(token).first();

  if (!row) {
    return htmlPage('Link not found', 'This confirmation link isn\'t valid — it may have already been used or the token is incorrect.');
  }

  if (row.confirmed) {
    return htmlPage('Already confirmed', 'Your application is already confirmed. We\'ll be in touch when founding creator access opens.');
  }

  await env.DB.prepare(
    `UPDATE waitlist SET confirmed = 1 WHERE id = ?`
  ).bind(row.id).run();

  return htmlPage('You\'re confirmed', 'Your application is confirmed. We\'ll reach out before founding creator access opens — you\'re near the front of the line.');
}

function htmlPage(heading, message) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading} — Brand Gita</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #EBE7DB; color: #1A1A18;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 2rem 1rem;
    }
    .card {
      background: #FDFCF9; border-radius: 12px; padding: 2.5rem 2rem;
      max-width: 420px; width: 100%; text-align: center;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .wordmark { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 2rem; text-decoration: none; color: #1A1A18; display: block; }
    h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.75rem; }
    p { font-size: 0.9rem; color: #4A4842; line-height: 1.6; font-weight: 300; }
    .home { display: inline-block; margin-top: 1.5rem; font-size: 0.875rem; color: #2196F3; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <a href="/" class="wordmark">Brand Gita</a>
    <h1>${heading}</h1>
    <p>${message}</p>
    <a href="/" class="home">← Back to brandgita.com</a>
  </div>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
