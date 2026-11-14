import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toEventSelector } from 'viem';
import { detectArb, detectLiquidation, LIQUIDATION_TOPICS, LIQUIDITY_TOPICS, tokenNet, tokensTouched, unwrappedBy, type Log, type Tx } from '../src/detect.ts';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const V3_SWAP = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)');
const V4_SWAP = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const EOA = addr(1);
const BOT = addr(2);
const POOL_A = addr(3);
const POOL_B = addr(4);
const WETH = addr(10);
const USDC = addr(11);

const padded = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`;
const transfer = (token: string, from: string, to: string, amount: bigint): Log => ({
  address: token,
  topics: [TRANSFER, padded(from), padded(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
});
const swap = (pool: string, topic: string = V3_SWAP): Log => ({ address: pool, topics: [topic], data: '0x' });
const tx = (logs: Log[], overrides: Partial<Tx> = {}): Tx => ({
  hash: '0xabc',
  from: EOA,
  to: BOT,
  value: 0n,
  success: true,
  txIndex: 5,
  logs,
  ...overrides,
});

const cycle = [
  transfer(WETH, BOT, POOL_A, 1000n),
  swap(POOL_A),
  transfer(USDC, POOL_A, BOT, 500n),
  transfer(USDC, BOT, POOL_B, 500n),
  swap(POOL_B),
  transfer(WETH, POOL_B, BOT, 1010n),
];

test('detects a two-hop cycle and reports the net gain', () => {
  assert.deepEqual(detectArb(tx(cycle)), { swaps: 2, token: WETH, profit: 10n, venues: ['v3'], pools: [POOL_A, POOL_B] });
});

test('labels every venue a route crosses', () => {
  const mixed = cycle.map((log, i) => (i === 4 ? swap(POOL_B, V4_SWAP) : log));
  assert.deepEqual(detectArb(tx(mixed))?.venues, ['v3', 'v4']);
});

test('detects a cycle routed directly from pool to pool', () => {
  const hit = detectArb(
    tx([
      transfer(WETH, BOT, POOL_A, 1000n),
      swap(POOL_A),
      transfer(USDC, POOL_A, POOL_B, 500n),
      swap(POOL_B),
      transfer(WETH, POOL_B, BOT, 1010n),
    ]),
  );
  assert.equal(hit?.profit, 10n);
});

test('keeps a flash-funded cycle where the loan passes through the bot', () => {
  const lender = addr(5);
  const hit = detectArb(tx([transfer(WETH, lender, BOT, 1000n), ...cycle, transfer(WETH, BOT, lender, 1000n)]));
  assert.equal(hit?.token, WETH);
  assert.equal(hit?.profit, 10n);
});

test('keeps a cycle that leaves rounding dust in an intermediate token', () => {
  const dusty = [...cycle, transfer(USDC, POOL_A, BOT, 0n)].map((log) => log);
  dusty[2] = transfer(USDC, POOL_A, BOT, 100_001n);
  dusty[3] = transfer(USDC, BOT, POOL_B, 100_000n);
  const hit = detectArb(tx(dusty));
  assert.equal(hit?.token, WETH);
  assert.equal(hit?.profit, 10n);
});

const LIQUIDATE_MORPHO = toEventSelector('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');

test('liquidation topics match the Morpho event seen in 0x45046fd0', () => {
  assert.ok([...LIQUIDATION_TOPICS].some((topic) => topic.startsWith('0xa4946ede')));
});

test('reports net flows for a liquidation that keeps the collateral', () => {
  const liquidation = detectLiquidation(
    tx([
      { address: POOL_A, topics: [LIQUIDATE_MORPHO], data: '0x' },
      transfer(WETH, POOL_A, BOT, 105n),
      transfer(USDC, BOT, POOL_A, 200n),
    ]),
  );
  assert.equal(liquidation?.protocol, 'morpho');
  assert.deepEqual([...liquidation!.flows], [[WETH, 105n], [USDC, -200n]]);
});

test('a liquidation that passes tokens straight through nets to nothing', () => {
  const liquidation = detectLiquidation(
    tx([{ address: POOL_A, topics: [LIQUIDATE_MORPHO], data: '0x' }, transfer(WETH, POOL_A, BOT, 5n), transfer(WETH, BOT, POOL_B, 5n)]),
  );
  assert.equal(liquidation?.flows.size, 0);
});

test('ignores reverted liquidations and transactions without the event', () => {
  const log: Log = { address: POOL_A, topics: [LIQUIDATE_MORPHO], data: '0x' };
  assert.equal(detectLiquidation(tx([log], { success: false })), null);
  assert.equal(detectLiquidation(tx(cycle)), null);
});

test('totals wrapped native unwrapped by the sender or executor only', () => {
  const withdrawal = (from: string, wad: bigint, token = WETH): Log => ({
    address: token,
    topics: [toEventSelector('Withdrawal(address,uint256)'), padded(from)],
    data: `0x${wad.toString(16).padStart(64, '0')}`,
  });
  const logs = [withdrawal(BOT, 7n), withdrawal(EOA, 3n), withdrawal(POOL_A, 100n), withdrawal(BOT, 50n, USDC)];
  assert.equal(unwrappedBy(tx(logs), WETH), 10n);
});

test('rejects CoW settlement batches, whose surplus resembles a cycle', () => {
  const settlement = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
  const logs = cycle.map((log) => JSON.parse(JSON.stringify(log).replaceAll(BOT.slice(2), settlement.slice(2).toLowerCase())) as Log);
  assert.equal(detectArb(tx(logs, { to: settlement })), null);
});

test('nets one token across the sender and executor', () => {
  assert.equal(tokenNet(tx(cycle), WETH), 10n);
  assert.equal(tokenNet(tx(cycle), USDC), 0n);
  assert.equal(tokenNet(tx(cycle), addr(99)), 0n);
});

test('lists each token moved by the transaction once', () => {
  assert.deepEqual(tokensTouched(tx(cycle)), [WETH, USDC].sort());
});

test('liquidity topics match the events seen on Base pools', () => {
  assert.ok(LIQUIDITY_TOPICS.has(toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)')));
  const prefixes = [...LIQUIDITY_TOPICS].map((topic) => topic.slice(0, 10));
  assert.ok(prefixes.includes('0x0c396cd9'), 'V3 Burn');
  assert.ok(prefixes.includes('0x70935338'), 'V3 Collect');
});

test('rejects any transaction that burns or mints liquidity', () => {
  const burn: Log = { address: POOL_A, topics: [toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)')], data: '0x' };
  assert.equal(detectArb(tx([burn, ...cycle])), null);
});

// Shape of 0xa61559cc...: a vault nets gains in both WETH and USDC after rebalancing.
test('rejects a round trip that gains in two tokens', () => {
  const rebalance = [
    transfer(WETH, BOT, POOL_A, 1000n),
    swap(POOL_A),
    transfer(WETH, POOL_A, BOT, 1100n),
    transfer(USDC, BOT, POOL_B, 2000n),
    swap(POOL_B),
    transfer(USDC, POOL_B, BOT, 2200n),
  ];
  assert.equal(detectArb(tx(rebalance)), null);
});

// Shape of 0xbaabc60c...: a large withdrawal next to a small swap.
test('rejects a large inflow next to a small outflow', () => {
  const withdrawal = [
    transfer(WETH, POOL_A, BOT, 35_000n),
    transfer(WETH, BOT, POOL_B, 300n),
    swap(POOL_B),
    swap(POOL_B),
  ];
  assert.equal(detectArb(tx(withdrawal)), null);
});

test('rejects a real-looking cycle next to a token that only arrives', () => {
  assert.equal(detectArb(tx([...cycle, transfer(addr(12), POOL_B, BOT, 7n)])), null);
});

// Shape of 0x691838d8...: a user sells through V4 and proceeds arrive with no outflow.
test('rejects a V4 sale whose proceeds only arrive', () => {
  const sale = [swap(POOL_A, V4_SWAP), swap(POOL_A, V4_SWAP), transfer(USDC, POOL_A, BOT, 399n)];
  assert.equal(detectArb(tx(sale)), null);
});

test('rejects a multi-hop user trade that spends one token for another', () => {
  const trade = [
    transfer(USDC, EOA, BOT, 500n),
    transfer(USDC, BOT, POOL_A, 500n),
    swap(POOL_A),
    swap(POOL_B),
    transfer(WETH, BOT, EOA, 1n),
    transfer(WETH, POOL_B, BOT, 1n),
  ];
  assert.equal(detectArb(tx(trade)), null);
});

test('rejects a purchase paid in native ETH', () => {
  assert.equal(detectArb(tx(cycle, { value: 1n })), null);
});

test('rejects a gain with no swaps behind it', () => {
  assert.equal(detectArb(tx([transfer(USDC, BOT, POOL_A, 1n), transfer(USDC, POOL_A, BOT, 2n)])), null);
});

test('rejects reverted transactions and contract creations', () => {
  assert.equal(detectArb(tx(cycle, { success: false })), null);
  assert.equal(detectArb(tx(cycle, { to: null })), null);
});

test('ignores ERC-721 transfers, which index the token id', () => {
  const nft: Log = { address: USDC, topics: [TRANSFER, padded(POOL_A), padded(BOT), padded(addr(7))], data: '0x' };
  assert.equal(detectArb(tx([...cycle, nft]))?.profit, 10n);
});
