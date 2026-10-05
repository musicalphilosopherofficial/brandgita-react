// Run with: node --test functions/_middleware.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from './_middleware.js'

const run = (url) => onRequest({ request: new Request(url), next: async () => new Response('site', { status: 200 }) })

test('www redirects 301 to the apex, keeping path and query', async () => {
  const res = await run('https://www.brandgita.com/features?x=1')
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), 'https://brandgita.com/features?x=1')
})

test('www root redirects to the apex root', async () => {
  const res = await run('https://www.brandgita.com/')
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), 'https://brandgita.com/')
})

test('the apex is served, not redirected', async () => {
  const res = await run('https://brandgita.com/apply')
  assert.equal(res.status, 200)
})

test('other hosts (preview deployments) are served, not redirected', async () => {
  const res = await run('https://abc123.brandgita-react.pages.dev/')
  assert.equal(res.status, 200)
})
