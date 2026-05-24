// Redirect /apply to the homepage.
// This replaces the previously deployed double opt-in confirmation page.
export async function onRequest() {
  return Response.redirect('https://brandgita.com/', 301);
}
