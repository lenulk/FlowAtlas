import test from 'node:test';
import assert from 'node:assert/strict';
import { planPairs, runPlannedSaves } from '../scripts/durable-group-commit-plan.mjs';

test('planPairs makes adjacent groups of at most two and keeps the final state identity', () => {
  const states = Array.from({ length: 35 }, (_, index) => ({ index }));
  const original = states.slice();
  const groups = planPairs(states);

  assert.equal(groups.length, 18);
  assert.deepEqual(groups.map(({ indices }) => [...indices]), [
    [0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15],
    [16, 17], [18, 19], [20, 21], [22, 23], [24, 25], [26, 27], [28, 29],
    [30, 31], [32, 33], [34],
  ]);
  assert.deepEqual(states, original);
  assert.ok(Object.isFrozen(groups));
  for (const group of groups) {
    assert.ok(Object.isFrozen(group));
    assert.ok(Object.isFrozen(group.indices));
    assert.strictEqual(group.state, states[group.indices.at(-1)]);
  }
  assert.throws(() => groups[0].indices.push(99), TypeError);
});

test('runPlannedSaves publishes a pair only after its save returns and stops at the first throw', () => {
  const states = Array.from({ length: 7 }, (_, index) => ({ index }));
  const groups = planPairs(states);
  const attempted = [];
  const result = runPlannedSaves(groups, (state) => {
    attempted.push(state);
    if (state === states[3]) throw new Error('private save detail');
  });

  assert.deepEqual(attempted, [states[1], states[3]]);
  assert.strictEqual(attempted[0], groups[0].state);
  assert.deepEqual(result, { publishedIndices: [0, 1], failedGroupIndex: 1 });
  assert.deepEqual(Object.keys(result), ['publishedIndices', 'failedGroupIndex']);
  assert.equal(JSON.stringify(result).includes('private save detail'), false);
});

test('runPlannedSaves reports completion after each successful synchronous save', () => {
  const states = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const saved = [];
  const result = runPlannedSaves(planPairs(states), (state) => saved.push(state));

  assert.deepEqual(saved, [states[1], states[2]]);
  assert.deepEqual(result, { publishedIndices: [0, 1, 2], failedGroupIndex: null });
});

test('runPlannedSaves accepts a baseline plan of 35 contiguous singleton saves', () => {
  const states = Array.from({ length: 35 }, (_, index) => ({ index }));
  const groups = states.map((state, index) => ({ indices: [index], state }));
  const saved = [];
  const result = runPlannedSaves(groups, (state) => saved.push(state));

  assert.deepEqual(saved, states);
  assert.deepEqual(result, { publishedIndices: Array.from({ length: 35 }, (_, index) => index), failedGroupIndex: null });
});

test('runPlannedSaves does not publish a group whose save returns a promise', () => {
  const states = Array.from({ length: 5 }, (_, index) => ({ index }));
  const attempted = [];
  const result = runPlannedSaves(planPairs(states), async (state) => {
    attempted.push(state);
    throw new Error('private asynchronous save detail');
  });

  assert.deepEqual(attempted, [states[1]]);
  assert.deepEqual(result, { publishedIndices: [], failedGroupIndex: 0 });
  assert.equal(JSON.stringify(result).includes('private asynchronous save detail'), false);
});

test('planPairs and runPlannedSaves reject invalid inputs', () => {
  for (const states of [null, {}, [], Array(36)]) {
    assert.throws(() => planPairs(states), TypeError);
  }
  assert.throws(() => runPlannedSaves([], null), TypeError);
  assert.throws(() => runPlannedSaves(null, () => {}), TypeError);
  assert.throws(() => runPlannedSaves([], () => {}), TypeError);
  assert.throws(() => runPlannedSaves([{ indices: [1], state: {} }], () => {}), TypeError);
  assert.throws(() => runPlannedSaves([{ indices: [0, 2], state: {} }], () => {}), TypeError);
  assert.throws(() => runPlannedSaves([{ indices: [0, 1, 2], state: {} }], () => {}), TypeError);
  assert.throws(() => runPlannedSaves([{ indices: [0], state: {} }, { indices: [2], state: {} }], () => {}), TypeError);
  assert.throws(() => runPlannedSaves(Array.from({ length: 19 }, (_, index) => ({
    indices: [index * 2, index * 2 + 1], state: {},
  })), () => {}), TypeError);
  assert.throws(() => runPlannedSaves(Array.from({ length: 18 }, (_, index) => ({
    indices: [index * 2, index * 2 + 1], state: {},
  })), () => {}), TypeError);
});
