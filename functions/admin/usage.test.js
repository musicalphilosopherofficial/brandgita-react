// Dashboard rendering — run with: node --test functions/admin/usage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './usage.js';

const SECRET = 'export-secret';
const basic = 'Basic ' + btoa('admin:' + SECRET);

function env(rows = {}, { fail = false } = {}) {
  return {
    EXPORT_SECRET: SECRET,
    DB: {
      prepare(sql) {
        return {
          async all() {
            if (fail) throw new Error('D1 exploded');
            if (sql.includes('GROUP BY event')) return { results: rows.rungs || [] };
            if (sql.includes('active_days')) return { results: rows.people || [] };
            if (sql.includes("'$.feature'")) return { results: rows.features || [] };
            if (sql.includes("'$.last_phase'")) return { results: rows.abandons || [] };
            return { results: [] };
          },
        };
      },
    },
  };
}

const req = (u = 'https://x/admin/usage', auth = basic) => ({
  url: u,
  method: 'GET',
  headers: { get: (h) => (h === 'Authorization' ? auth : null) },
});

async function body(e, u) {
  const res = await onRequest({ env: e, request: req(u) });
  return { res, html: await res.text() };
}

test('requires Basic Auth', async () => {
  const res = await onRequest({ env: env(), request: req('https://x/admin/usage', null) });
  assert.equal(res.status, 401);
});

test('renders the ladder with percentages of activated', async () => {
  const { html } = await body(env({
    rungs: [
      { event: 'app_activated', people: 10, events: 10 },
      { event: 'render_completed', people: 4, events: 9 },
      { event: 'published', people: 2, events: 3 },
    ],
  }));
  assert.match(html, /Activated/);
  assert.match(html, /40%/); // 4 of 10 rendered
  assert.match(html, /20%/); // 2 of 10 published
});

test('names the biggest drop-off — the thing to fix first', async () => {
  const { html } = await body(env({
    rungs: [
      { event: 'app_activated', people: 100, events: 100 },
      { event: 'onboarding_completed', people: 90, events: 90 },
      { event: 'pipeline_started', people: 20, events: 20 }, // the cliff
      { event: 'render_completed', people: 18, events: 18 },
      { event: 'published', people: 17, events: 17 },
    ],
  }));
  assert.match(html, /Biggest fall/);
  assert.match(html, /Onboarded → Started/);
});

// ── The two failure modes that would mislead the founder ──────────────────────
test('an EMPTY board says so, instead of reading as zero usage', async () => {
  const { html } = await body(env({}));
  assert.match(html, /No events yet/);
});

test('a FAILED query is flagged, never rendered as zeroes', async () => {
  // Silently showing 0 when the query blew up is the worst outcome here: it looks
  // exactly like "nobody is using the app" and would prompt the wrong decision.
  const { html } = await body(env({}, { fail: true }));
  assert.match(html, /query failed/i);
});

test('escapes DB-sourced strings — ingest is unauthenticated', async () => {
  const { html } = await body(env({
    features: [{ feature: '<img src=x onerror=alert(1)>', people: 1, uses: 1 }],
  }));
  assert.ok(!html.includes('<img src=x'), 'raw payload reached the HTML');
  assert.match(html, /&lt;img/);
});

test('never prints a full licence hash', async () => {
  const full = 'a'.repeat(64);
  const { html } = await body(env({ people: [{
    license_hash: full, events: 3, active_days: 2, last_seen: '2026-08-21',
    renders: 1, publishes: 1, publish_failures: 0,
  }] }));
  assert.ok(!html.includes(full), 'full hash rendered');
  assert.match(html, /aaaaaaaaaaaa…/);
});

test('days param is allowlisted — no SQL injection through the range', async () => {
  const { html } = await body(env({}), "https://x/admin/usage?days=7');DROP TABLE usage_events;--");
  assert.ok(!html.includes('DROP TABLE'));
});
