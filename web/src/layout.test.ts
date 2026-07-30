import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  closeSession,
  columnOf,
  emptyLayout,
  focusSession,
  moveSession,
  normalize,
  openIds,
  openSession,
} from './layout.ts';

test('sessions fill empty columns before doubling up', () => {
  let layout = openSession(emptyLayout(), 'a');
  assert.deepEqual(layout.columns, [['a'], [], []]);

  layout = openSession(layout, 'b');
  layout = openSession(layout, 'c');
  assert.deepEqual(layout.columns, [['a'], ['b'], ['c']], 'one per column while space remains');

  // No empty column left, so the fourth stacks into the middle.
  layout = openSession(layout, 'd');
  assert.deepEqual(layout.columns, [['a'], ['b', 'd'], ['c']]);
  assert.equal(layout.active[1], 'd', 'the newly opened session is frontmost');
});

test('opening an already-open session focuses it instead of duplicating it', () => {
  let layout = openSession(openSession(emptyLayout(), 'a'), 'b');
  layout = moveSession(layout, 'b', 0);
  assert.deepEqual(layout.columns, [['a', 'b'], [], []]);

  layout = focusSession(layout, 'a');
  layout = openSession(layout, 'b');
  assert.deepEqual(layout.columns, [['a', 'b'], [], []], 'no duplicate');
  assert.equal(layout.active[0], 'b');
});

test('a session can be dragged to another column', () => {
  let layout = openSession(openSession(emptyLayout(), 'a'), 'b');
  layout = moveSession(layout, 'a', 2);
  assert.deepEqual(layout.columns, [[], ['b'], ['a']]);
  assert.equal(layout.active[0], null, 'the vacated column has nothing to focus');
  assert.equal(layout.active[2], 'a');
  assert.equal(columnOf(layout, 'a'), 2);
});

test('moving to the current column is a focus, not a reorder', () => {
  let layout = emptyLayout();
  for (const id of ['a', 'b']) layout = moveSession(layout, id, 0);
  layout = focusSession(layout, 'a');
  layout = moveSession(layout, 'b', 0);
  assert.deepEqual(layout.columns, [['a', 'b'], [], []]);
  assert.equal(layout.active[0], 'b');
});

test('an out-of-range column is refused', () => {
  const layout = openSession(emptyLayout(), 'a');
  assert.deepEqual(moveSession(layout, 'a', 3), layout);
  assert.deepEqual(moveSession(layout, 'a', -1), layout);
});

test('closing the frontmost tab focuses the one that takes its place', () => {
  let layout = emptyLayout();
  for (const id of ['a', 'b', 'c']) layout = moveSession(layout, id, 0);

  layout = focusSession(layout, 'b');
  layout = closeSession(layout, 'b');
  assert.deepEqual(layout.columns[0], ['a', 'c']);
  assert.equal(layout.active[0], 'c', 'focus slides to whatever moved into the slot');

  // Closing the rightmost tab falls back to the new last one.
  layout = closeSession(layout, 'c');
  assert.equal(layout.active[0], 'a');

  layout = closeSession(layout, 'a');
  assert.deepEqual(layout.columns[0], []);
  assert.equal(layout.active[0], null);
});

test('closing a background tab leaves focus alone', () => {
  let layout = emptyLayout();
  for (const id of ['a', 'b']) layout = moveSession(layout, id, 0);
  layout = focusSession(layout, 'b');
  layout = closeSession(layout, 'a');
  assert.equal(layout.active[0], 'b');
});

test('closing a session that is not open changes nothing', () => {
  const layout = openSession(emptyLayout(), 'a');
  assert.deepEqual(closeSession(layout, 'zzz'), layout);
  assert.deepEqual(focusSession(layout, 'zzz'), layout);
  assert.equal(columnOf(layout, 'zzz'), -1);
});

test('openIds lists everything on screen in column order', () => {
  let layout = emptyLayout();
  for (const id of ['a', 'b', 'c']) layout = openSession(layout, id);
  layout = moveSession(layout, 'd', 0);
  assert.deepEqual(openIds(layout), ['a', 'd', 'b', 'c']);
});

test('a persisted layout is repaired against the sessions that still exist', () => {
  const known = new Set(['a', 'b']);

  // Deleted sessions, duplicates and a short columns array all get cleaned up.
  const repaired = normalize({ columns: [['a', 'gone', 'a'], ['b']], active: ['gone', 'b'] }, known);
  assert.deepEqual(repaired.columns, [['a'], ['b'], []]);
  assert.deepEqual(repaired.active, ['a', 'b', null], 'a dead active id falls back to the first tab');

  // A session listed twice is kept only where it first appeared.
  assert.deepEqual(normalize({ columns: [['a'], ['a'], []], active: [] }, known).columns, [['a'], [], []]);
});

test('garbage in storage yields an empty layout rather than throwing', () => {
  assert.deepEqual(normalize(null, new Set()), emptyLayout());
  assert.deepEqual(normalize({ columns: 'nope', active: 7 }, new Set(['a'])), emptyLayout());
  assert.deepEqual(normalize({ columns: [[1, {}, null]], active: [3] }, new Set(['a'])), emptyLayout());
});
