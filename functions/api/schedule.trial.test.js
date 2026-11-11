// Trial strategy through POST /api/schedule and PATCH /api/schedule/:id.
// Run: node --test functions/api/schedule.trial.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as schedule } from './schedule.js';
import { onRequest as scheduleId } from './schedule/[id].js';

const OWNER = 'ig-owner-1';
const futureISO = (d = 5) => new Date(Date.now() + d * 864e5).toISOString();

function makeEnv({ post = null } = {}) {
  const inserts = [];
  const updates = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('ig_tokens')) return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
                if (sql.includes('scheduled_posts')) return post;
                return null;
              },
              async all() { return { results: [] }; },
              async run() {
                if (sql.includes('INSERT')) inserts.push({ sql, args });
                if (sql.includes('UPDATE')) updates.push({ sql, args });
                return {};
              },
            };
          },
        };
      },
    },
    SCHEDULE_BUCKET: { head: async (key) => ({ key }), delete: async () => {}, put: async () => {} },
  };
  return { env, inserts, updates };
}

function req(method, body) {
  return { method, headers: { get: (k) => (k === 'Authorization' ? 'Bearer tok' : null) }, json: async () => body };
}

const createBody = (over = {}) => ({
  id: 'p1', type: 'reel', asset_keys: [`${OWNER}/a.mp4`], caption: 'hi', post_at: futureISO(), ...over,
});
async function create(over, opts) {
  const { env, inserts } = makeEnv();
  const res = await schedule({ request: req('POST', createBody(over)), env });
  return { res, data: await res.json(), inserts };
}
// The INSERT's trial_strategy bind. Columns holding SQL literals (status, permalink, ...) are not binds,
// so position in the column list is NOT position in args: map by counting the `?` placeholders instead.
function boundTrial({ sql, args }) {
  const cols = sql.match(/\(([^)]*)\)\s*VALUES/)[1].split(',').map((s) => s.trim());
  const vals = sql.match(/VALUES\s*\(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  assert.equal(cols.length, vals.length);
  const i = cols.indexOf('trial_strategy');
  assert.equal(vals[i], '?', 'trial_strategy must be a bound value');
  return args[vals.slice(0, i).filter((v) => v === '?').length];
}

test('POST: a reel with no trial_strategy is stored as NULL — a normal reel, never an implicit trial', async () => {
  const { res, inserts } = await create({});
  assert.equal(res.status, 200);
  assert.equal(boundTrial(inserts[0]), null);
});

test('POST: a reel that explicitly asks for SS_PERFORMANCE is stored as SS_PERFORMANCE', async () => {
  const { inserts } = await create({ trial_strategy: 'SS_PERFORMANCE' });
  assert.equal(boundTrial(inserts[0]), 'SS_PERFORMANCE');
});

test('POST: a reel with MANUAL is stored as MANUAL', async () => {
  const { inserts } = await create({ trial_strategy: 'MANUAL' });
  assert.equal(boundTrial(inserts[0]), 'MANUAL');
});

test('POST: a carousel with no trial_strategy is stored as NULL (not a trial)', async () => {
  const { res, inserts } = await create({ type: 'carousel', asset_keys: [`${OWNER}/a.jpg`, `${OWNER}/b.jpg`] });
  assert.equal(res.status, 200);
  assert.equal(boundTrial(inserts[0]), null);
});

test('POST: a carousel WITH a trial_strategy is rejected 400 and nothing is inserted', async () => {
  const { res, data, inserts } = await create({ type: 'carousel', asset_keys: [`${OWNER}/a.jpg`, `${OWNER}/b.jpg`], trial_strategy: 'MANUAL' });
  assert.equal(res.status, 400);
  assert.match(data.error, /trial.*reel/i);
  assert.equal(inserts.length, 0);
});

test('POST: an unknown strategy is a 400 naming the allowed values', async () => {
  const { res, data } = await create({ trial_strategy: 'AUTO' });
  assert.equal(res.status, 400);
  assert.match(data.error, /MANUAL.*SS_PERFORMANCE|SS_PERFORMANCE.*MANUAL/);
});

test('POST: trial problems are reported together with other problems', async () => {
  const { data } = await create({ asset_keys: [`${OWNER}/a.mp4`, `${OWNER}/b.mp4`], trial_strategy: 'AUTO' });
  assert.match(data.error, /exactly 1/);
  assert.match(data.error, /AUTO/);
});

// ── PATCH ─────────────────────────────────────────────────────────────────────
const scheduledReel = (over = {}) => ({
  id: 'post-1', ig_user_id: OWNER, status: 'scheduled', caption: 'c', post_at: futureISO(),
  platform: 'ig', type: 'reel', asset_keys: JSON.stringify([`${OWNER}/a.mp4`]), cover_key: null,
  trial_strategy: 'SS_PERFORMANCE', ...over,
});
async function patch(body, post) {
  const { env, updates } = makeEnv({ post });
  const res = await scheduleId({ request: req('PATCH', body), env, params: { id: 'post-1' } });
  return { res, data: await res.json(), updates };
}

test('PATCH: a scheduled reel can change to MANUAL; the UPDATE writes trial_strategy', async () => {
  const { res, data, updates } = await patch({ trial_strategy: 'MANUAL' }, scheduledReel());
  assert.equal(res.status, 200);
  assert.equal(data.trial_strategy, 'MANUAL');
  assert.match(updates[0].sql, /trial_strategy = \?/);
  assert.ok(updates[0].args.includes('MANUAL'));
});

for (const status of ['posting', 'posted', 'failed', 'cancelled']) {
  test(`PATCH: refused while status is '${status}', with a clear error and no UPDATE`, async () => {
    const { res, data, updates } = await patch({ trial_strategy: 'MANUAL' }, scheduledReel({ status }));
    assert.equal(res.status, 409);
    assert.match(data.error, new RegExp(status));
    assert.equal(updates.length, 0);
  });
}

test('PATCH: an unknown strategy is rejected 400', async () => {
  const { res, data } = await patch({ trial_strategy: 'AUTO' }, scheduledReel());
  assert.equal(res.status, 400);
  assert.match(data.error, /MANUAL/);
});

test('PATCH: null is rejected — there is no opt-out value, and null must not silently clear it', async () => {
  const { res, updates } = await patch({ trial_strategy: null }, scheduledReel());
  assert.equal(res.status, 400);
  assert.equal(updates.length, 0);
});

test('PATCH: a carousel cannot be given a trial strategy', async () => {
  const { res, data } = await patch({ trial_strategy: 'MANUAL' }, scheduledReel({ type: 'carousel', trial_strategy: null }));
  assert.equal(res.status, 400);
  assert.match(data.error, /trial.*reel/i);
});

// ── GET ───────────────────────────────────────────────────────────────────────
test('GET: the rows query selects trial_strategy', async () => {
  const sqls = [];
  const env = {
    DB: { prepare(sql) { sqls.push(sql); return { bind() { return { async first() { return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() }; }, async all() { return { results: [] }; } }; } }; } },
  };
  await schedule({ request: req('GET'), env });
  assert.ok(sqls.some((s) => s.includes('FROM scheduled_posts') && s.includes('trial_strategy')));
});
