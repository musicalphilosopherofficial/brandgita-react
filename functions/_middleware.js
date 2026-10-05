// One canonical host: https://brandgita.com. www.brandgita.com 301s to it,
// preserving path and query, so the TikTok form (and everything else) has a
// single URL. Pages Functions run before static assets, so this covers every path.
export async function onRequest(context) {
  const url = new URL(context.request.url)
  if (url.hostname === 'www.brandgita.com') {
    url.hostname = 'brandgita.com'
    return Response.redirect(url.toString(), 301)
  }
  return context.next()
}
