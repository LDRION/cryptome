import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextBaseFee, Q96, sqrtPriceAtTick, v2AmountOut, v3AmountOut, v3MaxIn, v3SwapInRange, type V3State } from '../src/amm.ts';

const E18 = 10n ** 18n;

test('V2 output matches the constant-product formula with a 0.3% fee', () => {
  // Computed separately in Python integer arithmetic.
  assert.equal(v2AmountOut(E18, 1000n * E18, 2000n * E18), 1992013962079806432n);
});

test('V2 keeps the invariant growing and handles empty inputs', () => {
  const out = v2AmountOut(5n * E18, 100n * E18, 300n * E18);
  assert.ok((100n * E18 + 5n * E18) * (300n * E18 - out) >= 100n * E18 * (300n * E18));
  assert.equal(v2AmountOut(0n, E18, E18), 0n);
  assert.equal(v2AmountOut(E18, 0n, E18), 0n);
});

const pool: V3State = { sqrtPriceX96: Q96, liquidity: 10n ** 24n, tick: 0, fee: 500, tickSpacing: 10 };

test('tick zero is a price of one', () => {
  assert.equal(sqrtPriceAtTick(0), Q96);
  const ratio = Number(sqrtPriceAtTick(10_000)) / Number(Q96);
  assert.ok(Math.abs(ratio ** 2 - 1.0001 ** 10_000) < 1e-6);
});

test('V3 swap moves price the right way and pays out less than the input at parity', () => {
  const down = v3SwapInRange(pool, E18, true);
  assert.ok(down.sqrtPriceX96 < pool.sqrtPriceX96);
  assert.ok(down.amountOut < E18 && down.amountOut > (E18 * 9990n) / 10_000n);

  const up = v3SwapInRange(pool, E18, false);
  assert.ok(up.sqrtPriceX96 > pool.sqrtPriceX96);
  assert.ok(up.amountOut < E18 && up.amountOut > (E18 * 9990n) / 10_000n);
});

test('a V3 round trip loses roughly two fees', () => {
  const there = v3SwapInRange(pool, E18, true);
  const moved = { ...pool, sqrtPriceX96: there.sqrtPriceX96 };
  const back = v3SwapInRange(moved, there.amountOut, false);
  const loss = Number(E18 - back.amountOut) / Number(E18);
  assert.ok(Math.abs(loss - 0.001) < 0.0001, `loss ${loss}`);
});

test('the V3 cap lands exactly on the tick-spacing boundary', () => {
  const up = v3MaxIn(pool, false);
  const landed = v3SwapInRange(pool, up, false).sqrtPriceX96;
  const boundary = sqrtPriceAtTick(10);
  assert.ok(Math.abs(Number(landed - boundary)) / Number(boundary) < 1e-9);
});

test('V3 quotes refuse to leave the range the model can see', () => {
  const cap = v3MaxIn(pool, false);
  assert.notEqual(v3AmountOut(pool, cap, false), null);
  assert.equal(v3AmountOut(pool, cap + 1n, false), null);
});

test('the V3 cap handles negative ticks and a price sitting on the boundary', () => {
  const negative: V3State = { ...pool, tick: -15, sqrtPriceX96: sqrtPriceAtTick(-15) };
  assert.ok(v3MaxIn(negative, true) > 0n);
  assert.ok(v3MaxIn(negative, false) > 0n);
  const onBoundary: V3State = { ...pool, tick: 10, sqrtPriceX96: sqrtPriceAtTick(10) };
  assert.equal(v3MaxIn(onBoundary, true), 0n);
});

test('an empty V3 range offers no depth', () => {
  const empty = { ...pool, liquidity: 0n };
  assert.equal(v3MaxIn(empty, true), 0n);
  assert.equal(v3SwapInRange(empty, E18, true).amountOut, 0n);
});

test('base fee follows EIP-1559 in each direction', () => {
  const fee = 8_000_000_000n;
  assert.equal(nextBaseFee(fee, 15_000_000n, 30_000_000n), fee);
  assert.equal(nextBaseFee(fee, 30_000_000n, 30_000_000n), 9_000_000_000n);
  assert.equal(nextBaseFee(fee, 0n, 30_000_000n), 7_000_000_000n);
  assert.equal(nextBaseFee(1n, 15_000_001n, 30_000_000n), 2n);
});
