import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapMeanInterval, quantile, sampleWindows, sum } from '../src/stats.ts';

test('sampled windows stay in range and never overlap', () => {
  const blocks = 15;
  const starts = sampleWindows(1_000_000, 302_400, 56, blocks, 7);
  assert.equal(starts.length, 56);
  assert.ok(starts[0]! >= 1_000_000 - 302_400);
  assert.ok(starts.at(-1)! + blocks <= 1_000_000);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! >= starts[i - 1]! + blocks);
});

test('sampled windows avoid a fixed time of day', () => {
  const starts = sampleWindows(1_000_000, 302_400, 56, 15, 7);
  const gaps = new Set(starts.slice(1).map((start, i) => start - starts[i]!));
  assert.ok(gaps.size > 40);
});

test('the same seed reproduces the same sample', () => {
  assert.deepEqual(sampleWindows(1000, 500, 5, 3, 42), sampleWindows(1000, 500, 5, 3, 42));
});

test('refuses a span too short for its windows', () => {
  assert.throws(() => sampleWindows(1000, 10, 5, 3));
});

test('bootstrap interval brackets the mean and widens with an outlier', () => {
  const calm = Array.from({ length: 50 }, (_, i) => i % 5);
  const [low, high] = bootstrapMeanInterval(calm);
  const mean = sum(calm) / calm.length;
  assert.ok(low <= mean && mean <= high);

  const [outlierLow, outlierHigh] = bootstrapMeanInterval([...calm.slice(1), 1000]);
  assert.ok(outlierHigh - outlierLow > (high - low) * 5);
});

test('bootstrap on an empty sample does not invent a range', () => {
  assert.deepEqual(bootstrapMeanInterval([]), [0, 0]);
});

test('quantile picks from the sorted values', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([3, 1, 2], 1), 3);
  assert.equal(quantile([], 0.5), 0);
});
