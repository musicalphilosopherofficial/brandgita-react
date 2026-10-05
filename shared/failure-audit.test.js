// A permanently failed post raises a system report into the bug_reports queue, which the
// existing drain turns into a Notion page and a GitHub issue — the founder's audit trail and
// ticket pathway. Run: node --test shared/failure-audit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raisePostFailure } from './failure-audit.js';

function makeEnv({ membership = 'mem_1', insertThrows = false } = {}) {
  const inserted = [];
  return {
    inserted,
    DB: {
      prepare(sql) {
        return {
          bind: (...args) => ({
            async first() { return sql.includes('ig_tokens') ? { whop_membership_id: membership } : null; },
            async run() {
              if (insertThrows) throw new Error('d1 down');
              inserted.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
  };
}
const post = { id: '0cc5fd02-2613-4066-b76b-7a8ad4234f0b', ig_user_id: 'ig1', type: 'reel', platform: 'ig', retry_count: 5, post_at: '2026-10-04T23:00:00.000Z' };

test('inserts one pending bug_reports row, tagged as a system alert', async () => {
  const env = makeEnv();
  await raisePostFailure(env, post, 'Media ID is not available');
  assert.equal(env.inserted.length, 1);
  const [id, membership, payload] = env.inserted[0].args;
  assert.match(id, /^bg-[0-9a-f]{16}$/);
  assert.equal(membership, 'mem_1');
  assert.match(env.inserted[0].sql, /'bug'/);
  const p = JSON.parse(payload);
  assert.equal(p.diagnostics.source, 'system');
  assert.equal(p.diagnostics.post_id, post.id);
  assert.match(p.untrusted_user_input.summary, /post.*failed/i);
  assert.match(p.untrusted_user_input.summary, /Media ID is not available/);
  assert.match(env.inserted[0].sql, /INSERT OR IGNORE/);
});

test('the report id is deterministic per post, so a repeat cannot create duplicate tickets', async () => {
  const a = makeEnv(); const b = makeEnv();
  await raisePostFailure(a, post, 'x'); await raisePostFailure(b, post, 'y');
  assert.equal(a.inserted[0].args[0], b.inserted[0].args[0]);
});

test('falls back to a system membership when the account has none', async () => {
  const env = makeEnv({ membership: null });
  await raisePostFailure(env, post, 'x');
  assert.equal(env.inserted[0].args[1], 'system');
});

test('never throws — an audit failure must not turn into a publishing failure', async () => {
  const env = makeEnv({ insertThrows: true });
  await assert.doesNotReject(raisePostFailure(env, post, 'x'));
});

test('very long error text is bounded', async () => {
  const env = makeEnv();
  await raisePostFailure(env, post, 'e'.repeat(5000));
  assert.ok(JSON.parse(env.inserted[0].args[2]).untrusted_user_input.summary.length < 700);
});
