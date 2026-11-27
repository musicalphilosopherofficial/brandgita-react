// Run: node --test shared/collaborators.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCollaborators, MAX_COLLABORATORS } from './collaborators.js';
import { contractFor } from './platform-contracts.js';

test('none: undefined, null and [] are all "no collaborators"', () => {
  for (const v of [undefined, null, []]) assert.deepEqual(validateCollaborators(v), { usernames: null, problems: [] });
});
test('up to 3 names; "@" stripped; spaces trimmed; repeats (any case) count once', () => {
  assert.equal(MAX_COLLABORATORS, 3);
  assert.deepEqual(validateCollaborators([' @a.b ', 'c_d', 'C_D', '@e']).usernames, ['a.b', 'c_d', 'e']);
});
test('a 4th distinct name is refused', () => {
  const r = validateCollaborators(['a', 'b', 'c', 'd']);
  assert.equal(r.usernames, null);
  assert.match(r.problems[0], /at most 3/);
});
test('bad usernames and non-lists are refused, naming the entry', () => {
  assert.match(validateCollaborators('a').problems[0], /list/);
  for (const bad of ['', '@', 'has space', 'x'.repeat(31), 5]) {
    assert.match(validateCollaborators(['ok', bad]).problems[0], /collaborators\[1\]/, String(bad));
  }
});
test('which content types take collaborators: IG reel and carousel; not story; not TikTok', () => {
  const ig = contractFor('ig');
  assert.equal(ig.shapes.reel.collaborators, true);
  assert.equal(ig.shapes.carousel.collaborators, true);
  assert.ok(!ig.shapes.story.collaborators);
  assert.ok(!contractFor('tt').shapes.reel.collaborators);
});
