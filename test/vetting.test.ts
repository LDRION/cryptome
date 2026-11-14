import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, toEventSelector } from 'viem';
import { addWin, newRecallStats, winWasFound } from '../src/paper/recall.ts';
import { PoolBook, poolKeyOf, V4_MODIFY, V4_POOL_MANAGER, V4_SWAP, type PoolLog, type PoolMeta } from '../src/paper/pools.ts';
import { outputTransferMatches, parseInitialize, tokenPasses, v4Meta, v4PoolId } from '../src/paper/vetting.ts';
import { sqrtPriceAtTick, v3SwapInRange } from '../src/amm.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const HOOK = '0x00000000000000000000000000000000000000aa';

test('computes the id of a real V4 pool seen on mainnet', () => {
  // ETH/USDC at fee 100, spacing 1: this id carried 185 swaps in 300 blocks when checked.
  const id = v4PoolId({ currency0: ZERO, currency1: USDC, fee: 100, tickSpacing: 1, hooks: ZERO });
  assert.equal(id, '0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7');
});

test('reads a pool key back from an Initialize log', () => {
  const padded = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`;
  const log = {
    topics: [toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'), `0x${'ab'.repeat(32)}`, padded(ZERO), padded(USDC)],
    data: encodeAbiParameters(
      [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
      [100, -60, HOOK as `0x${string}`, 1n, -5],
    ),
  };
  assert.deepEqual(parseInitialize(log), { currency0: ZERO, currency1: USDC, fee: 100, tickSpacing: -60, hooks: HOOK });
});

const key = { currency0: ZERO, currency1: USDC, fee: 100, tickSpacing: 1, hooks: ZERO };

test('a hookless pool routes native ETH as the wrapped token', () => {
  const meta = v4Meta('0xAB', key, WETH);
  assert.deepEqual(meta, { address: '0xab', kind: 'v4', token0: WETH, token1: USDC, fee: 100, tickSpacing: 1 });
});

test('pools with a hook or a dynamic fee are refused', () => {
  assert.equal(v4Meta('0xab', { ...key, hooks: HOOK }, WETH), null);
  assert.equal(v4Meta('0xab', { ...key, fee: 0x800000 }, WETH), null);
});

const POOL = '0x00000000000000000000000000000000000000bb';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const transfer = (token: string, from: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, `0x${from.slice(2).padStart(64, '0')}`, `0x${'c'.repeat(64)}`],
  data: `0x${value.toString(16).padStart(64, '0')}`,
});

test('an untaxed token pays out exactly what the swap log says', () => {
  assert.equal(outputTransferMatches([transfer(USDC, POOL, 500n)], USDC, POOL, 500n), true);
});

test('a tax shows up as a transfer split away from the logged amount', () => {
  const taxed = [transfer(USDC, POOL, 450n), transfer(USDC, POOL, 50n)];
  assert.equal(outputTransferMatches(taxed, USDC, POOL, 500n), false);
});

test('transfers of another token or from another sender do not count', () => {
  assert.equal(outputTransferMatches([transfer(WETH, POOL, 500n)], USDC, POOL, 500n), false);
  assert.equal(outputTransferMatches([transfer(USDC, HOOK, 500n)], USDC, POOL, 500n), false);
});

test('a token needs enough evidence and no contradiction', () => {
  assert.equal(tokenPasses([]), false);
  assert.equal(tokenPasses([true]), false);
  assert.equal(tokenPasses([true, true]), true);
  assert.equal(tokenPasses([true, true, false]), false);
});

const V4_ID = `0x${'cd'.repeat(32)}`;
const v4: PoolMeta = { address: V4_ID, kind: 'v4', token0: WETH, token1: USDC, fee: 500, tickSpacing: 10 };
const LIQUIDITY = 10n ** 24n;

const v4Swap = (amount0: bigint, amount1: bigint, price: bigint, liquidity: bigint, tick: number, fee = 500): PoolLog => ({
  address: V4_POOL_MANAGER,
  topics: [V4_SWAP, V4_ID, `0x${'e'.repeat(64)}`],
  data: encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [amount0, amount1, price, liquidity, tick, fee],
  ),
  transactionHash: '0xv4',
  logIndex: '0x1',
});

test('all V4 pools share one contract but keep separate identities', () => {
  assert.equal(poolKeyOf({ address: V4_POOL_MANAGER.toUpperCase().replace('0X', '0x'), topics: ['0xsig', V4_ID] }), V4_ID);
  assert.equal(poolKeyOf({ address: POOL, topics: ['0xsig', V4_ID] }), POOL);
});

test('V4 swap logs set the state and price the pool like V3', () => {
  const book = new PoolBook([v4]);
  assert.equal(book.apply(v4Swap(-1n, 1n, sqrtPriceAtTick(0), LIQUIDITY, 0)), V4_ID);
  assert.equal(book.isReady(V4_ID), true);
  assert.ok(Math.abs(book.rate(V4_ID, true)! - (1 - 0.0005)) < 1e-9);
});

test('the model reads the V4 sign convention in both directions', () => {
  const start = { sqrtPriceX96: sqrtPriceAtTick(0), liquidity: LIQUIDITY, tick: 0, fee: 500, tickSpacing: 10 };
  const amountIn = 10n ** 18n;
  for (const zeroForOne of [true, false]) {
    const book = new PoolBook([v4]);
    book.apply(v4Swap(-1n, 1n, start.sqrtPriceX96, LIQUIDITY, 0));
    const { amountOut, sqrtPriceX96 } = v3SwapInRange(start, amountIn, zeroForOne);
    // The swapper pays in, so the input is negative and the output positive.
    book.apply(zeroForOne ? v4Swap(-amountIn, amountOut, sqrtPriceX96, LIQUIDITY, 0) : v4Swap(amountOut, -amountIn, sqrtPriceX96, LIQUIDITY, 0));
    assert.equal(book.modelErrors.v4.length, 1);
    assert.equal(book.modelErrors.v4[0], 0, zeroForOne ? 'zero for one' : 'one for zero');
  }
});

test('the V4 check uses the fee each swap reports', () => {
  const start = { sqrtPriceX96: sqrtPriceAtTick(0), liquidity: LIQUIDITY, tick: 0, fee: 3000, tickSpacing: 10 };
  const book = new PoolBook([v4]);
  book.apply(v4Swap(-1n, 1n, start.sqrtPriceX96, LIQUIDITY, 0));
  const { amountOut, sqrtPriceX96 } = v3SwapInRange(start, 10n ** 18n, true);
  book.apply(v4Swap(-(10n ** 18n), amountOut, sqrtPriceX96, LIQUIDITY, 0, 3000));
  assert.equal(book.modelErrors.v4[0], 0);
});

test('V4 liquidity changes apply only in range and can go down', () => {
  const book = new PoolBook([v4]);
  book.apply(v4Swap(-1n, 1n, sqrtPriceAtTick(0), LIQUIDITY, 0));
  const modify = (lower: number, upper: number, delta: bigint): PoolLog => ({
    address: V4_POOL_MANAGER,
    topics: [V4_MODIFY, V4_ID, `0x${'e'.repeat(64)}`],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], [lower, upper, delta, `0x${'0'.repeat(64)}`]),
    transactionHash: '0xlp',
    logIndex: '0x2',
  });
  assert.equal(book.apply(modify(100, 200, LIQUIDITY)), null);
  const before = book.maxIn(V4_ID, false);
  assert.equal(book.apply(modify(-100, 100, -LIQUIDITY / 2n)), V4_ID);
  assert.ok(book.maxIn(V4_ID, false) < before);
});

const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;

test('a win on two pools needs two matching pools', () => {
  assert.equal(winWasFound([A, B], [[A, C]]), false);
  assert.equal(winWasFound([A, B], [[A, B]]), true);
  assert.equal(winWasFound([A, B, C], [[A, B]]), true);
});

test('matches must come from one route, not be stitched across routes', () => {
  assert.equal(winWasFound([A, B], [[A, C], [B, C]]), false);
});

test('a win through V4 matches any of our V4 pools', () => {
  assert.equal(winWasFound([A, V4_POOL_MANAGER], [[A, V4_ID]]), true);
  assert.equal(winWasFound([A, V4_POOL_MANAGER], [[A, B]]), false);
});

test('repeated pools in a win count once, and no routes finds nothing', () => {
  assert.equal(winWasFound([A, A], [[A, C]]), true);
  assert.equal(winWasFound([A, B], []), false);
});

test('recall adds up wins and the profit behind them', () => {
  const stats = newRecallStats();
  addWin(stats, true, 10);
  addWin(stats, false, 90);
  assert.deepEqual(stats, { wins: 2, found: 1, retainedUsd: 100, foundRetainedUsd: 10 });
});
