import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { deployedMatchesBuild, encodeRun, encodeRunBatch, holdsNativeEth, hopsOf } from '../src/executor.ts';
import type { Rpc } from '../src/rpc.ts';
import type { PoolMeta } from '../src/paper/pools.ts';
import { v4PoolId } from '../src/paper/vetting.ts';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZERO = '0x0000000000000000000000000000000000000000';

const v3: PoolMeta = { address: '0x00000000000000000000000000000000000000a1', kind: 'v3', token0: USDC, token1: WETH, fee: 500, tickSpacing: 10 };
const nativeId = v4PoolId({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO });
const nativePool: PoolMeta = { address: nativeId, kind: 'v4', token0: WETH, token1: USDC, fee: 500, tickSpacing: 10 };
const wrappedId = v4PoolId({ currency0: USDC, currency1: WETH, fee: 100, tickSpacing: 1, hooks: ZERO });
const wrappedPool: PoolMeta = { address: wrappedId, kind: 'v4', token0: USDC, token1: WETH, fee: 100, tickSpacing: 1 };

test('a V4 pool holds native ETH only when its id says so', () => {
  assert.equal(holdsNativeEth(nativePool, WETH), true);
  assert.equal(holdsNativeEth(wrappedPool, WETH), false);
  assert.equal(holdsNativeEth(v3, WETH), false);
  // Same tokens and terms, but the id belongs to another pool.
  assert.equal(holdsNativeEth({ ...nativePool, address: wrappedId }, WETH), false);
});

test('a route becomes swaps with the right direction on each pool', () => {
  const metas = new Map([v3, nativePool].map((meta) => [meta.address, meta]));
  const hops = hopsOf([WETH, USDC], [v3.address, nativePool.address], metas, WETH);
  assert.deepEqual(hops.map((hop) => [hop.tokenIn, hop.tokenOut, hop.zeroForOne]), [
    [WETH, USDC, false],
    [USDC, WETH, false],
  ]);
  assert.equal(hops[0]!.pool, v3.address);
  assert.equal(hops[1]!.pool, ZERO, 'V4 pools have no address of their own');
  assert.equal(hops[1]!.nativeLeg, true);
});

test('a route that does not match its pools is refused', () => {
  const metas = new Map([[v3.address, v3]]);
  assert.throws(() => hopsOf([WETH, '0x00000000000000000000000000000000000000b2'], [v3.address, v3.address], metas, WETH), /does not trade/);
  assert.throws(() => hopsOf([WETH, USDC], ['0xmissing'], metas, WETH), /Unknown pool/);
});

test('the encoded call carries the amount and the minimum profit', () => {
  const metas = new Map([[v3.address, v3]]);
  const data = encodeRun(WETH, 1234n, hopsOf([WETH, USDC], [v3.address], metas, WETH), 99n);
  const abi = parseAbi([
    'struct Hop { uint8 kind; address pool; bool zeroForOne; address tokenIn; address tokenOut; uint24 fee; int24 tickSpacing; bool nativeLeg; uint256 priceAtDecision; }',
    'function run(address start, uint256 amountIn, Hop[] hops, uint256 minProfit, uint256 startGap, uint256 minGap, uint256 targetBlock)',
  ]);
  const decoded = decodeFunctionData({ abi, data });
  assert.equal(decoded.args[1], 1234n);
  assert.equal(decoded.args[3], 99n);
  assert.equal(decoded.args[2].length, 1);
  assert.equal(decoded.args[2][0]!.priceAtDecision, 0n);
  assert.equal(decoded.args[4], 0n, 'no gap given means no check');
  assert.equal(decoded.args[6], 0n, 'no target block given means any block');
});

test('a batch carries each route with its own minimum and gas limit', () => {
  const metas = new Map([[v3.address, v3]]);
  const hops = hopsOf([WETH, USDC], [v3.address], metas, WETH);
  const data = encodeRunBatch(
    [
      { start: WETH, amountIn: 5n, hops, minProfit: 7n, startGap: 3n, minGap: 1n, gasLimit: 300_000n },
      { start: USDC, amountIn: 6n, hops, minProfit: 8n, startGap: 4n, minGap: 2n, gasLimit: 400_000n },
    ],
    55n,
  );
  const abi = parseAbi([
    'struct Hop { uint8 kind; address pool; bool zeroForOne; address tokenIn; address tokenOut; uint24 fee; int24 tickSpacing; bool nativeLeg; uint256 priceAtDecision; }',
    'struct Route { address start; uint256 amountIn; Hop[] hops; uint256 minProfit; uint256 startGap; uint256 minGap; uint256 gasLimit; }',
    'function runBatch(Route[] routes, uint256 targetBlock)',
  ]);
  const decoded = decodeFunctionData({ abi, data });
  assert.deepEqual(decoded.args[0].map((route) => [route.amountIn, route.minProfit, route.startGap, route.minGap, route.gasLimit]), [
    [5n, 7n, 3n, 1n, 300_000n],
    [6n, 8n, 4n, 2n, 400_000n],
  ]);
  assert.equal(decoded.args[1], 55n);
});

test('a contract is accepted only when its code on chain is exactly this build', async () => {
  const node = (code: string): Rpc => ({
    call: async <T>(method: string) => (method === 'eth_getCode' ? code : '0xABC') as T,
  });
  assert.equal(await deployedMatchesBuild(node('0xabc'), '0x1', '0x2', '0x0000000000000000000000000000000000000003'), true, 'hex case does not matter');
  assert.equal(await deployedMatchesBuild(node('0xabd'), '0x1', '0x2', '0x0000000000000000000000000000000000000003'), false);
});

test('prices, the gap and the target block reach the contract', () => {
  const metas = new Map([[v3.address, v3]]);
  const data = encodeRun(WETH, 1n, hopsOf([WETH, USDC], [v3.address], metas, WETH, [777n]), 0n, 55n, { startGap: 9n, minGap: 4n });
  const abi = parseAbi([
    'struct Hop { uint8 kind; address pool; bool zeroForOne; address tokenIn; address tokenOut; uint24 fee; int24 tickSpacing; bool nativeLeg; uint256 priceAtDecision; }',
    'function run(address start, uint256 amountIn, Hop[] hops, uint256 minProfit, uint256 startGap, uint256 minGap, uint256 targetBlock)',
  ]);
  const decoded = decodeFunctionData({ abi, data });
  assert.equal(decoded.args[2][0]!.priceAtDecision, 777n);
  assert.equal(decoded.args[4], 9n);
  assert.equal(decoded.args[5], 4n);
  assert.equal(decoded.args[6], 55n);
});
