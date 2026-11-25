// Instagram STORY through POST/PATCH /api/schedule.
// Run: node --test functions/api/schedule.story.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as schedule } from './schedule.js';
import { onRequest as scheduleId } from './schedule/[id].js';

const OWNER = 'ig-owner-1';
const futureISO = (d = 5) => new Date(Date.now() + d * 864e5).toISOString();

function makeEnv({ post = null, assetAspect = null } = {}) {
  const inserts = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('ig_tokens')) return { ig_user_id: OWNER, desktop_token_created_at: new Date().toISOString() };
                if (sql.includes('FROM assets')) return assetAspect ? { aspect: assetAspect } : null;
                if (sql.includes('scheduled_posts')) return post;
                return null;
              },
              async all() { return { results: [] }; },
              async run() { if (sql.includes('INSERT')) inserts.push({ sql, args }); return {}; },
            };
          },
        };
      },
    },
    SCHEDULE_BUCKET: { head: async (key) => ({ key }), delete: async () => {}, put: async () => {} },
  };
  return { env, inserts };
}
const req = (method, body) => ({ method, headers: { get: (k) => (k === 'Authorization' ? 'Bearer tok' : null) }, json: async () => body });
const body = (over = {}) => ({ id: 's1', type: 'story', asset_keys: [`${OWNER}/a.jpg`], post_at: futureISO(), ...over });
async function create(over, opts) {
  const { env, inserts } = makeEnv(opts);
  const res = await schedule({ request: req('POST', body(over)), env });
  return { res, data: await res.json(), inserts };
}

test('a story with one .jpg and NO caption is created: {ok,id,post_at}, caption stored as empty', async () => {
  const { res, data, inserts } = await create();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(data).sort(), ['id', 'ok', 'post_at']);
  assert.equal(inserts.length, 1);
  assert.ok(inserts[0].args.includes('story'));
  assert.ok(inserts[0].args.includes(''), 'caption bound as the empty string');
});

test('a story with one .mp4 is created', async () => {
  assert.equal((await create({ asset_keys: [`${OWNER}/a.mp4`] })).res.status, 200);
});

test('a story with a caption is a 400 that says so; nothing is inserted', async () => {
  const { res, data, inserts } = await create({ caption: 'hello' });
  assert.equal(res.status, 400);
  assert.match(data.error, /story cannot have a caption/);
  assert.equal(inserts.length, 0);
});

test('a story with a cover_key is a 400', async () => {
  const { res, data } = await create({ cover_key: `${OWNER}/c.jpg` });
  assert.equal(res.status, 400);
  assert.match(data.error, /cover/);
});

test('two assets, zero assets, and a PNG are each a 400', async () => {
  assert.equal((await create({ asset_keys: [`${OWNER}/a.jpg`, `${OWNER}/b.jpg`] })).res.status, 400);
  assert.equal((await create({ asset_keys: [] })).res.status, 400);
  assert.equal((await create({ asset_keys: [`${OWNER}/a.png`] })).res.status, 400);
});

test('post_at obeys the same window as reels: >45 days out is refused', async () => {
  const { res, data } = await create({ post_at: futureISO(46) });
  assert.equal(res.status, 400);
  assert.match(data.error, /45 days/);
});

test('a foreign asset key is refused (same ownership rule as every type)', async () => {
  assert.equal((await create({ asset_keys: ['someone-else/a.jpg'] })).res.status, 403);
});

test('reel and carousel still REQUIRE a caption (unchanged)', async () => {
  const r = await create({ type: 'reel', asset_keys: [`${OWNER}/a.mp4`] });
  assert.equal(r.res.status, 400);
  assert.match(r.data.error, /caption/);
});

test('trial_strategy on a story is refused (trials are reels only)', async () => {
  const { res, data } = await create({ trial_strategy: 'MANUAL' });
  assert.equal(res.status, 400);
  assert.match(data.error, /trial/);
});

test('optional `media` facts: a 61s video is a 400; a 1:1 image is accepted WITH a letterbox warning', async () => {
  const bad = await create({ asset_keys: [`${OWNER}/a.mp4`], media: { width: 1080, height: 1920, duration_sec: 61 } });
  assert.equal(bad.res.status, 400);
  assert.match(bad.data.error, /60s/);
  const warn = await create({ media: { width: 1080, height: 1080 } });
  assert.equal(warn.res.status, 200);
  assert.equal(warn.data.warnings.length, 1);
  assert.match(warn.data.warnings[0], /letterbox/i);
});

test('without `media`, an asset TAGGED 1:1 at upload time still yields the warning', async () => {
  const { res, data } = await create({}, { assetAspect: '1:1' });
  assert.equal(res.status, 200);
  assert.match(data.warnings[0], /letterbox/i);
});

test('a clean 9:16 story has NO warnings key (response shape unchanged)', async () => {
  const { data } = await create({ media: { width: 1080, height: 1920 } });
  assert.equal('warnings' in data, false);
});

test('PATCH on a story cannot add a caption', async () => {
  const post = { id: 's1', ig_user_id: OWNER, status: 'scheduled', caption: '', post_at: futureISO(), platform: 'ig', type: 'story', asset_keys: JSON.stringify([`${OWNER}/a.jpg`]), cover_key: null };
  const { env } = makeEnv({ post });
  const res = await scheduleId({ request: req('PATCH', { caption: 'nope' }), env, params: { id: 's1' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /story cannot have a caption/);
});

// ── user_tags (the only story parameter Meta supports beyond the media itself) ──
test('a story with user_tags is created and the tags are stored as normalised JSON', async () => {
  const { res, inserts } = await create({ user_tags: [{ username: '@kevin', x: 0.5, y: 0.8 }, { username: 'rock' }] });
  assert.equal(res.status, 200);
  const stored = inserts[0].args.find((a) => typeof a === 'string' && a.includes('kevin'));
  assert.deepEqual(JSON.parse(stored), [{ username: 'kevin', x: 0.5, y: 0.8 }, { username: 'rock' }]);
});

test('a story with no user_tags stores NULL, not "[]"', async () => {
  const { inserts } = await create();
  assert.ok(!inserts[0].args.includes('[]'));
});

test('bad user_tags are a 400 naming the entry', async () => {
  const { res, data } = await create({ user_tags: [{ username: 'ok' }, { username: 'bad name' }] });
  assert.equal(res.status, 400);
  assert.match(data.error, /user_tags\[1\]/);
});

test('user_tags on a reel is refused (never silently dropped) and names what supports it', async () => {
  const { res, data } = await create({ type: 'reel', asset_keys: [`${OWNER}/a.mp4`], caption: 'hi', user_tags: [{ username: 'a' }] });
  assert.equal(res.status, 400);
  assert.match(data.error, /user_tags.*story/);
});

test('PATCH can set user_tags on a scheduled story, and clear them with null', async () => {
  const post = { id: 's1', ig_user_id: OWNER, status: 'scheduled', caption: '', post_at: futureISO(), platform: 'ig', type: 'story', asset_keys: JSON.stringify([`${OWNER}/a.jpg`]), cover_key: null, user_tags: null };
  const { env } = makeEnv({ post });
  const res = await scheduleId({ request: req('PATCH', { user_tags: [{ username: 'x1' }] }), env, params: { id: 's1' } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).user_tags, [{ username: 'x1' }]);
  const cleared = await scheduleId({ request: req('PATCH', { user_tags: null }), env: makeEnv({ post }).env, params: { id: 's1' } });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).user_tags, null);
});
