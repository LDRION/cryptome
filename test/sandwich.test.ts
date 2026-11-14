import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters } from 'viem';
import { isSandwich, swapZeroForOne, type RouteSwap } from '../src/paper/sandwich.ts';
import { V2_SWAP, V3_SWAP, V4_SWAP, type PoolLog } from '../src/paper/pools.ts';

const POOL = '0xpool';
const BOT = '0xbot';
const swap = (txHash: string, zeroForOne: boolean, from: string, to = `${from}-contract`, pool = POOL): RouteSwap => ({ txHash, pool, zeroForOne, from, to });

// Shape of block 26333520: the bot buys 275k, a visible 1.5k trade lands, the bot sells back.
test('recognises a real sandwich from mainnet', () => {
  const swaps = [swap('0xfront', true, BOT), swap('0xvictim', true, '0xuser'), swap('0xback', false, BOT)];
  assert.equal(isSandwich(['0xfront', '0xvictim'], swaps), true);
});

test('the victim alone being the visible part still marks the sandwich', () => {
  const swaps = [swap('0xfront', true, BOT), swap('0xvictim', true, '0xuser'), swap('0xback', false, BOT)];
  assert.equal(isSandwich(['0xvictim'], swaps), true);
});

test('a bot rotating senders behind one contract is still the same actor', () => {
  const swaps = [swap('0xfront', true, '0xeoa1', BOT), swap('0xvictim', true, '0xuser'), swap('0xback', false, '0xeoa2', BOT)];
  assert.equal(isSandwich(['0xfront'], swaps), true);
});

test('two strangers going through one public router are not one actor', () => {
  const router = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
  const swaps = [swap('0xa', true, '0xalice', router), swap('0xb', true, '0xcarol'), swap('0xc', false, '0xbob', router)];
  assert.equal(isSandwich(['0xa'], swaps), false);
});

test('a real arbitrage right after a large trade is not a sandwich', () => {
  const swaps = [swap('0xwhale', true, '0xwhale-eoa'), swap('0xarb', false, BOT)];
  assert.equal(isSandwich(['0xwhale'], swaps), false);
});

test('the same actor trading back with nobody in between is not a sandwich', () => {
  const swaps = [swap('0xa', true, BOT), swap('0xb', false, BOT)];
  assert.equal(isSandwich(['0xa'], swaps), false);
});

test('the same actor moving one way twice is not a sandwich', () => {
  const swaps = [swap('0xa', true, BOT), swap('0xv', true, '0xuser'), swap('0xb', true, BOT)];
  assert.equal(isSandwich(['0xa'], swaps), false);
});

test('a reversal on another pool does not count', () => {
  const swaps = [swap('0xa', true, BOT), swap('0xv', true, '0xuser'), swap('0xb', false, BOT, `${BOT}-contract`, '0xother')];
  assert.equal(isSandwich(['0xa'], swaps), false);
});

test('a sandwich elsewhere in the block does not taint a gap it did not open', () => {
  const swaps = [swap('0xfront', true, BOT), swap('0xvictim', true, '0xuser'), swap('0xback', false, BOT), swap('0xlater', true, '0xwhale')];
  assert.equal(isSandwich(['0xlater'], swaps), false);
});

const log = (topic: string, data: string): PoolLog => ({ address: POOL, topics: [topic], data, transactionHash: '0x', logIndex: '0x0' });
const pair = (a: bigint, b: bigint): string => encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }], [a, b]);

test('reads swap direction from each venue with its own sign convention', () => {
  assert.equal(swapZeroForOne(log(V3_SWAP, pair(5n, -3n))), true, 'V3: the pool received token0');
  assert.equal(swapZeroForOne(log(V3_SWAP, pair(-5n, 3n))), false);
  assert.equal(swapZeroForOne(log(V4_SWAP, pair(-5n, 3n))), true, 'V4: the swapper paid token0');
  assert.equal(swapZeroForOne(log(V4_SWAP, pair(5n, -3n))), false);
  assert.equal(swapZeroForOne(log(V2_SWAP, pair(5n, 0n))), true, 'V2: token0 came in');
  assert.equal(swapZeroForOne(log(V2_SWAP, pair(0n, 5n))), false);
});
