export async function onRequest(context) {
  const url = new URL(context.request.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  // No params — not an OAuth callback, serve the static page
  if (!code && !error) return context.next();

  // Server-side 302 to custom scheme — Chrome treats this as a top-level navigation
  // and shows the "Open Brand Gita?" prompt reliably (unlike JS-initiated navigation)
  const dest = code
    ? `brandgita://oauth/instagram?code=${encodeURIComponent(code)}`
    : `brandgita://oauth/instagram?error=${encodeURIComponent(error)}`;

  return new Response(null, {
    status: 302,
    headers: { Location: dest },
  });
}
