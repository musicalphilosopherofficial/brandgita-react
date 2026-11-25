// user_tags: users mentioned in a post, validated once for every platform that supports them.
// Run: node --test shared/user-tags.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUserTags, MAX_USER_TAGS } from './user-tags.js';

test('absent or null means no tags and no problems', () => {
  assert.deepEqual(validateUserTags(undefined), { tags: null, problems: [] });
  assert.deepEqual(validateUserTags(null), { tags: null, problems: [] });
  assert.deepEqual(validateUserTags([]), { tags: null, problems: [] });
});

test('a username-only tag is valid; a leading @ is stripped', () => {
  assert.deepEqual(validateUserTags([{ username: '@some.one_1' }]).tags, [{ username: 'some.one_1' }]);
});

test('x and y are floats in 0..1 (edges allowed) and kept', () => {
  assert.deepEqual(validateUserTags([{ username: 'a', x: 0, y: 1 }]).tags, [{ username: 'a', x: 0, y: 1 }]);
  assert.deepEqual(validateUserTags([{ username: 'a', x: 0.5, y: 0.25 }]).problems, []);
});

test('x or y out of range, non-numeric, or given without the other is a problem', () => {
  for (const bad of [{ x: 1.1, y: 0.5 }, { x: -0.1, y: 0.5 }, { x: 'a', y: 0.5 }, { x: 0.5 }, { y: 0.5 }]) {
    assert.equal(validateUserTags([{ username: 'a', ...bad }]).problems.length, 1, JSON.stringify(bad));
  }
});

test('a bad username is a problem naming the entry', () => {
  for (const u of ['', 'has space', 'a'.repeat(31), 5, undefined]) {
    const r = validateUserTags([{ username: u }]);
    assert.equal(r.problems.length, 1, String(u));
    assert.match(r.problems[0], /user_tags\[0\]/);
  }
});

test('not an array, or an entry that is not an object, is a problem', () => {
  assert.match(validateUserTags('a').problems[0], /list/);
  assert.match(validateUserTags(['a']).problems[0], /user_tags\[0\]/);
});

test('duplicates collapse to one (first wins) and the cap is enforced', () => {
  assert.equal(validateUserTags([{ username: 'a' }, { username: 'A' }, { username: '@a' }]).tags.length, 1);
  const many = Array.from({ length: MAX_USER_TAGS + 1 }, (_, i) => ({ username: `u${i}` }));
  assert.match(validateUserTags(many).problems[0], new RegExp(String(MAX_USER_TAGS)));
});
