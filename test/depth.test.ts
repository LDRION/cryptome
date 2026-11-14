import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters } from 'viem';
import { maxInputAcrossTicks, sqrtPriceAtTick, swapAcrossTicks, v3SwapInRange, type Depth, type V3State } from '../src/amm.ts';
import { ticksInWord, wordOfTick } from '../src/paper/depth.ts';
import { PoolBook, V3_BURN, V3_MINT, V3_SWAP, type PoolLog, type PoolMeta } from '../src/paper/pools.ts';

const E18 = 10n ** 18n;
const L = 10n ** 24n;
const state: V3State = { sqrtPriceX96: sqrtPriceAtTick(5), liquidity: L, tick: 5, fee: 500, tickSpacing: 10 };
const wide: Depth = { ticks: [], lowTick: -2560, highTick: 2560 };
const close = (actual: bigint, expected: bigint, tolerance = 1e-9): void => {
  const error = Math.abs(Number(actual - expected)) / Number(expected);
  assert.ok(error <= tolerance, `${actual} vs ${expected}: ${error}`);
};

test('with no ticks in the way it matches the in-range math exactly', () => {
  for (const zeroForOne of [true, false]) {
    const crossing = swapAcrossTicks(state, wide, E18, zeroForOne)!;
    const inRange = v3SwapInRange(state, E18, zeroForOne);
    assert.equal(crossing.amountOut, inRange.amountOut);
    assert.equal(crossing.sqrtPriceX96, inRange.sqrtPriceX96);
    assert.equal(crossing.crossed, 0);
  }
});

test('crossing a tick that removes liquidity pays out less than staying deep', () => {
  // Moving up past tick 10 removes half the liquidity, as an LP range ending there would.
  const thinning: Depth = { ...wide, ticks: [{ tick: 10, liquidityNet: -L / 2n }] };
  const big = v3SwapInRange(state, 10n ** 22n, false).amountOut;
  const crossed = swapAcrossTicks(state, thinning, 10n ** 22n, false)!;
  assert.equal(crossed.crossed, 1);
  assert.equal(crossed.liquidity, L / 2n);
  assert.ok(crossed.amountOut < big);
});

test('moving down applies the net with the opposite sign', () => {
  // Moving down across tick 0 into a range with less liquidity: net positive going up.
  const below: Depth = { ...wide, ticks: [{ tick: 0, liquidityNet: L / 2n }] };
  const crossed = swapAcrossTicks(state, below, 10n ** 22n, true)!;
  assert.equal(crossed.liquidity, L / 2n);
  assert.equal(crossed.crossed, 1);
});

test('crossing into more liquidity lets a large swap go further at a better rate', () => {
  const deeper: Depth = { ...wide, ticks: [{ tick: 10, liquidityNet: L * 9n }] };
  const flat = swapAcrossTicks(state, wide, 10n ** 22n, false)!;
  const crossed = swapAcrossTicks(state, deeper, 10n ** 22n, false)!;
  assert.ok(crossed.amountOut > flat.amountOut);
  assert.ok(crossed.sqrtPriceX96 < flat.sqrtPriceX96, 'deeper liquidity moves price less');
});

test('splitting a swap at a tick with no net change gives the same result', () => {
  const marker: Depth = { ...wide, ticks: [{ tick: 10, liquidityNet: 0n }] };
  const whole = swapAcrossTicks(state, wide, 10n ** 22n, false)!;
  const split = swapAcrossTicks(state, marker, 10n ** 22n, false)!;
  assert.equal(split.crossed, 1);
  close(split.amountOut, whole.amountOut);
});

test('jumps a gap with no liquidity to reach the next range', () => {
  const gapped: V3State = { ...state, liquidity: 0n };
  const depth: Depth = { ...wide, ticks: [{ tick: 20, liquidityNet: L }] };
  const crossed = swapAcrossTicks(gapped, depth, E18, false)!;
  assert.ok(crossed.amountOut > 0n);
  assert.equal(crossed.liquidity, L);
});

test('refuses to leave the range the reading covers', () => {
  const narrow: Depth = { ticks: [], lowTick: 0, highTick: 20 };
  const max = maxInputAcrossTicks(state, narrow, false);
  assert.notEqual(swapAcrossTicks(state, narrow, max - 1n, false), null);
  assert.equal(swapAcrossTicks(state, narrow, max + E18, false), null);
});

test('refuses liquidity that would go negative, which means a stale reading', () => {
  const stale: Depth = { ...wide, ticks: [{ tick: 10, liquidityNet: -L * 2n }] };
  assert.equal(swapAcrossTicks(state, stale, 10n ** 22n, false), null);
});

test('the input limit grows as liquidity deepens past a tick', () => {
  const flat = maxInputAcrossTicks(state, wide, false);
  const deeper = maxInputAcrossTicks(state, { ...wide, ticks: [{ tick: 10, liquidityNet: L * 9n }] }, false);
  assert.ok(deeper > flat);
  assert.ok(flat > 0n);
});

test('a price exactly on a tick moving down crosses it without paying for the step', () => {
  const onTick: V3State = { ...state, tick: 10, sqrtPriceX96: sqrtPriceAtTick(10) };
  const depth: Depth = { ...wide, ticks: [{ tick: 10, liquidityNet: L / 2n }] };
  const crossed = swapAcrossTicks(onTick, depth, E18, true)!;
  assert.equal(crossed.crossed, 1);
  assert.equal(crossed.liquidity, L / 2n);
  assert.ok(crossed.amountOut > 0n);
});

test('finds the bitmap word of a tick, including negative ticks', () => {
  assert.equal(wordOfTick(0, 10), 0);
  assert.equal(wordOfTick(2559, 10), 0);
  assert.equal(wordOfTick(2560, 10), 1);
  assert.equal(wordOfTick(-1, 10), -1);
  assert.equal(wordOfTick(-2560, 10), -1);
  assert.equal(wordOfTick(-2561, 10), -2);
});

test('reads initialized ticks out of a bitmap word', () => {
  assert.deepEqual(ticksInWord(0b101n, 0, 10), [0, 20]);
  assert.deepEqual(ticksInWord(1n, -1, 10), [-2560]);
  assert.deepEqual(ticksInWord(1n << 255n, 0, 60), [15300]);
  assert.deepEqual(ticksInWord(0n, 3, 1), []);
});

const POOL = `0x${'a'.repeat(40)}`;
const meta: PoolMeta = { address: POOL, kind: 'v3', token0: `0x${'1'.repeat(40)}`, token1: `0x${'2'.repeat(40)}`, fee: 500, tickSpacing: 10 };
let index = 0;
const swapLog = (a0: bigint, a1: bigint, price: bigint, liquidity: bigint, tick: number): PoolLog => ({
  address: POOL,
  topics: [V3_SWAP],
  data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [a0, a1, price, liquidity, tick]),
  transactionHash: '0xswap',
  logIndex: `0x${(index++).toString(16)}`,
});
const topic = (value: number): string => `0x${BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0')}`;
const lpLog = (kind: string, lower: number, upper: number, amount: bigint): PoolLog => ({
  address: POOL,
  topics: [kind, topic(1), topic(lower), topic(upper)],
  data:
    kind === V3_MINT
      ? encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [POOL as `0x${string}`, amount, 0n, 0n])
      : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [amount, 0n, 0n]),
  transactionHash: '0xlp',
  logIndex: `0x${(index++).toString(16)}`,
});

const started = (): PoolBook => {
  const book = new PoolBook([meta]);
  book.apply(swapLog(-1n, 1n, sqrtPriceAtTick(5), L, 5));
  return book;
};

test('with depth loaded the book quotes past one tick spacing', () => {
  const book = started();
  const oneTick = book.maxIn(POOL, false);
  assert.equal(book.quote(POOL, oneTick * 100n, false), null);
  book.setDepth(POOL, { ...wide, ticks: [{ tick: 10, liquidityNet: 0n }] });
  assert.ok(book.maxIn(POOL, false) > oneTick * 100n);
  assert.ok(book.quote(POOL, oneTick * 100n, false)! > 0n);
});

test('a pool that moved outside its reading falls back to the safe one-tick limit', () => {
  const book = started();
  const fallback = book.maxIn(POOL, false);
  book.setDepth(POOL, { ticks: [], lowTick: 1000, highTick: 2000 });
  assert.equal(book.maxIn(POOL, false), fallback);
});

test('a real crossing swap is checked against the depth reading, separately from trust', () => {
  const book = started();
  book.setDepth(POOL, { ...wide, ticks: [{ tick: 10, liquidityNet: L }] });
  const amountIn = 10n ** 22n;
  const predicted = swapAcrossTicks({ sqrtPriceX96: sqrtPriceAtTick(5), liquidity: L, tick: 5, fee: 500, tickSpacing: 10 }, { ...wide, ticks: [{ tick: 10, liquidityNet: L }] }, amountIn, false)!;
  book.apply(swapLog(-predicted.amountOut, amountIn, predicted.sqrtPriceX96, predicted.liquidity, 20));
  assert.equal(book.modelErrors.crossing.length, 1);
  assert.equal(book.modelErrors.crossing[0], 0);
  assert.equal(book.modelErrors.v3.length, 0, 'a crossing swap does not count toward pool trust');
});

test('new liquidity updates the reading when tracking is on', () => {
  const book = started();
  book.setDepth(POOL, { ...wide, ticks: [{ tick: 100, liquidityNet: 7n }] });
  book.trackDepthChanges = true;
  book.apply(lpLog(V3_MINT, 100, 200, 5n));
  book.apply(lpLog(V3_BURN, 100, 200, 2n));
  const depth = (book as unknown as { depths: Map<string, Depth> }).depths.get(POOL)!;
  assert.deepEqual(depth.ticks, [{ tick: 100, liquidityNet: 10n }, { tick: 200, liquidityNet: -3n }]);
});

test('liquidity logs leave the reading alone during a replay of past blocks', () => {
  const book = started();
  book.setDepth(POOL, { ...wide, ticks: [{ tick: 100, liquidityNet: 7n }] });
  book.apply(lpLog(V3_MINT, 100, 200, 5n));
  const depth = (book as unknown as { depths: Map<string, Depth> }).depths.get(POOL)!;
  assert.deepEqual(depth.ticks, [{ tick: 100, liquidityNet: 7n }]);
});

test('a new tick is inserted in order and ticks outside the reading are ignored', () => {
  const book = started();
  book.setDepth(POOL, { ticks: [{ tick: 100, liquidityNet: 1n }, { tick: 300, liquidityNet: 1n }], lowTick: 0, highTick: 500 });
  book.trackDepthChanges = true;
  book.apply(lpLog(V3_MINT, 200, 900, 4n));
  const depth = (book as unknown as { depths: Map<string, Depth> }).depths.get(POOL)!;
  assert.deepEqual(depth.ticks.map((entry) => entry.tick), [100, 200, 300]);
});
