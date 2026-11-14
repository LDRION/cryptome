import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFlows, realProfit, type CallFrame } from '../src/trace.ts';

const MINER = '0xaaaa';
const BOT = '0xbbbb';
const OWNER = '0xcccc';
const POOL = '0xdddd';
const WETH = '0xeeee';
const entity = new Set([BOT]);
const flowsOf = (root: CallFrame) => nativeFlows(root, MINER, entity, WETH);

const call = (from: string, to: string, value: bigint, extra: Partial<CallFrame> = {}): CallFrame => ({
  type: 'CALL',
  from,
  to,
  value: `0x${value.toString(16)}`,
  ...extra,
});

test('sums payments to the miner at any depth and from any frame', () => {
  const root = call('0x1', BOT, 0n, { calls: [call(BOT, POOL, 0n, { calls: [call(POOL, MINER, 5n)] }), call(BOT, MINER, 7n)] });
  assert.equal(flowsOf(root).toMiner, 12n);
});

test('matches the miner regardless of address case', () => {
  assert.equal(flowsOf(call(BOT, '0xAAAA', 3n)).toMiner, 3n);
});

test('skips a reverted subtree entirely', () => {
  const reverted = call(BOT, POOL, 0n, { error: 'execution reverted', calls: [call(POOL, MINER, 100n), call(BOT, POOL, 9n)] });
  const flows = flowsOf(call('0x1', BOT, 0n, { calls: [reverted, call(BOT, MINER, 1n)] }));
  assert.equal(flows.toMiner, 1n);
  assert.equal(flows.byCounterparty.size, 0);
});

test('ignores the value repeated on delegate and static calls', () => {
  const root = call('0x1', BOT, 0n, { calls: [{ ...call(BOT, MINER, 9n), type: 'DELEGATECALL' }, { ...call(BOT, POOL, 9n), type: 'STATICCALL' }] });
  const flows = flowsOf(root);
  assert.equal(flows.toMiner, 0n);
  assert.equal(flows.byCounterparty.size, 0);
});

test('nets native legs per counterparty', () => {
  const root = call('0x1', BOT, 0n, { calls: [call(BOT, POOL, 10n), call(POOL, BOT, 3n), call(BOT, OWNER, 4n)] });
  assert.deepEqual([...flowsOf(root).byCounterparty], [[POOL, -7n], [OWNER, -4n]]);
});

test('leaves out wrapping, unwrapping and transfers it is not party to', () => {
  const root = call('0x1', BOT, 0n, { calls: [call(WETH, BOT, 8n), call(BOT, WETH, 2n), call(POOL, OWNER, 50n)] });
  assert.equal(flowsOf(root).byCounterparty.size, 0);
});

test('handles frames without a value or children', () => {
  assert.equal(flowsOf({ from: BOT, to: POOL }).toMiner, 0n);
});

const ETH = 10n ** 18n;

// Simplified from 0x3549a14d: the bot unwraps 84.5 WETH, pays it into a native V4 pool
// and collects 85.1 WETH on V3. Token logs alone report the whole 85.1 as profit.
test('a native V4 leg does not count as profit', () => {
  const wrappedNet = (851n * ETH) / 10n;
  const legsNet = -(845n * ETH) / 10n;
  const { grossUsd, minerUsd, retainedUsd } = realProfit({
    hitUsd: 85.1 * 2300,
    gainIsWrapped: true,
    wrappedNet,
    legsNet,
    toMiner: (5n * ETH) / 10n,
    nativeUsd: 2300,
    gasUsd: 40,
  });
  assert.ok(Math.abs(grossUsd - 0.6 * 2300) < 1e-6);
  assert.ok(Math.abs(minerUsd - 0.5 * 2300) < 1e-6);
  assert.ok(Math.abs(retainedUsd - (0.1 * 2300 - 40)) < 1e-6);
});

// Shape of bot 0xc1062b7c: native arrives from a contract and leaves to a plain address.
test('native passing straight through is not profit', () => {
  const root = call('0x1', BOT, 0n, { calls: [call(POOL, BOT, 90n * ETH), call(BOT, OWNER, 90n * ETH)] });
  const flows = flowsOf(root);
  const legsNet = [...flows.byCounterparty.values()].reduce((a, b) => a + b, 0n);
  const { grossUsd } = realProfit({ hitUsd: 10, gainIsWrapped: true, wrappedNet: 0n, legsNet, toMiner: flows.toMiner, nativeUsd: 2000, gasUsd: 0 });
  assert.equal(grossUsd, 0);
});

test('keeps a stablecoin gain and subtracts the wrapped native spent to earn it', () => {
  const { grossUsd } = realProfit({ hitUsd: 100, gainIsWrapped: false, wrappedNet: -ETH / 100n, legsNet: 0n, toMiner: 0n, nativeUsd: 2000, gasUsd: 1 });
  assert.ok(Math.abs(grossUsd - 80) < 1e-6);
});

test('a builder payment above the real gain leaves a loss', () => {
  const { retainedUsd } = realProfit({ hitUsd: 2000, gainIsWrapped: true, wrappedNet: ETH, legsNet: 0n, toMiner: 2n * ETH, nativeUsd: 2000, gasUsd: 0 });
  assert.equal(retainedUsd, -2000);
});
