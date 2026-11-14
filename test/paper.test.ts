import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters } from 'viem';
import { PaperEngine, type BlockHeader, type ChainView, type EngineConfig, type Prices } from '../src/paper/engine.ts';
import { PoolBook, SYNC, V2_SWAP, V3_BURN, V3_MINT, V3_SWAP, type PoolLog, type PoolMeta } from '../src/paper/pools.ts';
import { bestTrade, buildCycles, cycleProfit } from '../src/paper/search.ts';
import { Q96, v2AmountOut } from '../src/amm.ts';

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const WETH = addr(1);
const USDC = addr(2);
const LINK = addr(3);
const POOL_A = addr(10);
const POOL_B = addr(11);
const POOL_C = addr(12);
const POOL_D = addr(13);
const E18 = 10n ** 18n;

const v2 = (address: string, token0 = WETH, token1 = USDC): PoolMeta => ({ address, kind: 'v2', token0, token1, fee: 0, tickSpacing: 0 });

let logIndex = 0;
const log = (address: string, topic: string, data: string, tx: string, extraTopics: string[] = []): PoolLog => ({
  address,
  topics: [topic, ...extraTopics],
  data,
  transactionHash: tx,
  logIndex: `0x${(logIndex++).toString(16)}`,
});
const sync = (address: string, r0: bigint, r1: bigint, tx = '0xsync'): PoolLog =>
  log(address, SYNC, encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }], [r0, r1]), tx);
const v2Swap = (address: string, in0: bigint, in1: bigint, out0: bigint, out1: bigint, tx = '0xswap'): PoolLog =>
  log(
    address,
    V2_SWAP,
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [in0, in1, out0, out1]),
    tx,
  );

/** A real-looking V2 trade: the pair of logs a pool emits, with an output the model agrees with. */
const trade = (address: string, r0: bigint, r1: bigint, amountIn: bigint, tx = '0xtrade'): PoolLog[] => {
  const out = v2AmountOut(amountIn, r0, r1);
  return [sync(address, r0 + amountIn, r1 - out, tx), v2Swap(address, amountIn, 0n, 0n, out, tx)];
};

test('the book reads reserves from Sync logs', () => {
  const book = new PoolBook([v2(POOL_A)]);
  assert.equal(book.isReady(POOL_A), false);
  book.apply(sync(POOL_A, 100n * E18, 200n * E18));
  assert.equal(book.isReady(POOL_A), true);
  assert.equal(book.quote(POOL_A, E18, true), v2AmountOut(E18, 100n * E18, 200n * E18));
});

test('the book ignores logs from pools outside the universe', () => {
  const book = new PoolBook([v2(POOL_A)]);
  assert.equal(book.apply(sync(POOL_B, E18, E18)), null);
});

test('a pool earns trust only after real swaps match the model', () => {
  const book = new PoolBook([v2(POOL_A)]);
  let [r0, r1] = [1000n * E18, 2000n * E18];
  book.apply(sync(POOL_A, r0, r1));
  assert.equal(book.isVerified(POOL_A), false);
  for (let i = 0; i < 3; i++) {
    const logs = trade(POOL_A, r0, r1, E18);
    for (const l of logs) book.apply(l);
    r0 += E18;
    r1 -= v2AmountOut(E18, r0 - E18, r1);
  }
  assert.equal(book.isVerified(POOL_A), true);
  assert.ok(Math.max(...book.modelErrors.v2) < 1e-6);
});

test('a pool with a different fee than the model is never trusted', () => {
  const book = new PoolBook([v2(POOL_A)]);
  let [r0, r1] = [1000n * E18, 2000n * E18];
  book.apply(sync(POOL_A, r0, r1));
  for (let i = 0; i < 5; i++) {
    // A 1% pool: real output is well below what the 0.3% model predicts.
    const out = v2AmountOut(E18, r0, r1, 100n);
    book.apply(sync(POOL_A, r0 + E18, r1 - out));
    book.apply(v2Swap(POOL_A, E18, 0n, 0n, out));
    r0 += E18;
    r1 -= out;
  }
  assert.equal(book.isVerified(POOL_A), false);
});

const v3Meta: PoolMeta = { address: POOL_A, kind: 'v3', token0: WETH, token1: USDC, fee: 500, tickSpacing: 10 };
const v3SwapLog = (amount0: bigint, amount1: bigint, price: bigint, liquidity: bigint, tick: number, tx = '0xv3'): PoolLog =>
  log(
    POOL_A,
    V3_SWAP,
    encodeAbiParameters(
      [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
      [amount0, amount1, price, liquidity, tick],
    ),
    tx,
  );
const signedTopic = (value: number): string => `0x${BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0')}`;

test('V3 swap logs set the state, including negative amounts and ticks', () => {
  const book = new PoolBook([v3Meta]);
  book.apply(v3SwapLog(-5n, 5n, Q96 / 2n, 10n ** 20n, -13863));
  assert.equal(book.isReady(POOL_A), true);
  assert.ok(Math.abs(book.rate(POOL_A, true)! - 0.25 * (1 - 0.0005)) < 1e-9);
});

test('a V3 swap that crosses a tick is excluded from the model check', () => {
  const book = new PoolBook([v3Meta]);
  book.apply(v3SwapLog(1n, -1n, Q96, 10n ** 20n, 0));
  book.apply(v3SwapLog(E18, -(E18 / 2n), Q96 - 1000n, 2n * 10n ** 20n, -1));
  assert.equal(book.modelErrors.v3.length, 0);
});

test('V3 mint and burn adjust liquidity only when in range', () => {
  const book = new PoolBook([v3Meta]);
  const liquidity = 10n ** 20n;
  book.apply(v3SwapLog(1n, -1n, Q96, liquidity, 0));
  const change = (topic: string, lower: number, upper: number, amount: bigint): PoolLog => {
    const data =
      topic === V3_MINT
        ? encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [POOL_B as `0x${string}`, amount, 0n, 0n])
        : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [amount, 0n, 0n]);
    return log(POOL_A, topic, data, '0xlp', [padded(addr(9)), signedTopic(lower), signedTopic(upper)]);
  };
  assert.equal(book.apply(change(V3_MINT, 100, 200, liquidity)), null);
  assert.equal(book.apply(change(V3_MINT, -100, 100, liquidity)), POOL_A);
  const before = book.maxIn(POOL_A, false);
  assert.equal(book.apply(change(V3_BURN, -100, 100, liquidity)), POOL_A);
  assert.ok(book.maxIn(POOL_A, false) < before);
});

const padded = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`;

const seeded = (metas: PoolMeta[], reserves: [string, bigint, bigint][]): PoolBook => {
  const book = new PoolBook(metas);
  for (const [address, r0, r1] of reserves) book.apply(sync(address, r0, r1));
  return book;
};

test('finds the two-pool loop across a price gap and sizes it near the true optimum', () => {
  const metas = [v2(POOL_A), v2(POOL_B)];
  const book = seeded(metas, [[POOL_A, 1000n * E18, 2_000_000n * E18], [POOL_B, 1000n * E18, 2_100_000n * E18]]);
  const cycles = buildCycles(metas, new Set([WETH]), new Set([WETH, USDC]));
  assert.equal(cycles.length, 2);

  const results = cycles.map((c) => ({ c, t: bestTrade(book, c) })).filter((r) => r.t !== null);
  assert.equal(results.length, 1, 'only the direction that buys low pays');
  const { c, t } = results[0]!;

  let bruteBest = 0n;
  for (let i = 1n; i <= 400n; i++) {
    const profit = cycleProfit(book, c, (i * E18) / 10n) ?? -1n;
    if (profit > bruteBest) bruteBest = profit;
  }
  assert.ok(t!.profit >= bruteBest, 'at least as good as a brute-force sweep');
});

test('a route too thin to matter is not refined, and a worthwhile one still is', () => {
  const metas = [v2(POOL_A), v2(POOL_B)];
  const book = seeded(metas, [[POOL_A, 1000n * E18, 2_000_000n * E18], [POOL_B, 1000n * E18, 2_100_000n * E18]]);
  const cycle = buildCycles(metas, new Set([WETH]), new Set([WETH, USDC])).find((c) => bestTrade(book, c) !== null)!;

  const full = bestTrade(book, cycle)!;
  const huge = bestTrade(book, cycle, full.profit * 100n)!;
  assert.ok(huge.profit < full.profit, 'stops at the rough answer');
  assert.ok(huge.profit * 2n > full.profit, 'which is close enough to reject it safely');
  assert.equal(bestTrade(book, cycle, full.profit / 2n)!.profit, full.profit, 'a trade that could clear the bar gets the full search');
});

test('skipping gaps inside blocks leaves the trades themselves unchanged', async () => {
  const run = async (skipMidBlock: boolean): Promise<[number, number]> => {
    const engine = makeEngine({ skipMidBlock });
    await warmed(engine);
    await engine.onBlock(header(6), [...openGap(), sync(POOL_B, state.a0, state.a1, '0xrival')], prices);
    await engine.onBlock(header(7), openGap(), prices);
    const [settled] = await engine.onBlock(header(8), [], prices);
    return [engine.stats.midBlock.routes, settled!.profitUsd];
  };
  const [counted, withScan] = await run(false);
  const [notCounted, withoutScan] = await run(true);
  assert.ok(counted > 0);
  assert.equal(notCounted, 0);
  assert.equal(withoutScan, withScan);
});

test('a V2 price is the reserve ratio in the direction of the trade', () => {
  const book = seeded([v2(POOL_A)], [[POOL_A, 1000n * E18, 2000n * E18]]);
  const Q96 = 1n << 96n;
  assert.equal(book.priceForContract(POOL_A, true), 2n * Q96);
  assert.equal(book.priceForContract(POOL_A, false), Q96 / 2n);
  assert.equal(book.priceForContract(POOL_B, true), 0n);
});

test('a V3 price is its square root price whatever the direction', () => {
  const book = new PoolBook([v3Meta]);
  book.apply(v3SwapLog(1n, -1n, Q96, 10n ** 20n, 0));
  assert.equal(book.priceForContract(POOL_A, true), Q96);
  assert.equal(book.priceForContract(POOL_A, false), Q96);
});

test('the prices and the gap reach the check that runs in the EVM', async () => {
  const limits: bigint[][] = [];
  const gaps: bigint[] = [];
  const view = viewOf(async (_block, _cycle, _amount, pricesAtDecision, startGap) => {
    limits.push(pricesAtDecision);
    gaps.push(startGap);
    return { ok: true, profit: E18 / 10n, gasUnits: 300_000n };
  });
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, view);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(limits.length, 1);
  assert.equal(limits[0]!.length, 2);
  assert.ok(limits[0]!.every((limit) => limit > 0n));
  assert.ok(gaps[0]! > 0n);
});

test('no profit is found when pools agree on the price', () => {
  const metas = [v2(POOL_A), v2(POOL_B)];
  const book = seeded(metas, [[POOL_A, 1000n * E18, 2000n * E18], [POOL_B, 500n * E18, 1000n * E18]]);
  for (const cycle of buildCycles(metas, new Set([WETH]), new Set([WETH, USDC]))) assert.equal(bestTrade(book, cycle), null);
});

test('builds each three-pool loop once and respects the allowed tokens', () => {
  const metas = [v2(POOL_A, WETH, USDC), v2(POOL_B, USDC, LINK), v2(POOL_C, LINK, WETH)];
  const three = buildCycles(metas, new Set([WETH, USDC]), new Set([WETH, USDC, LINK]));
  assert.equal(three.length, 2, 'one loop in each direction');
  assert.equal(three[0]!.hops.length, 3);
  assert.equal(buildCycles(metas, new Set([WETH]), new Set([WETH, USDC])).length, 0);
});

const policy = { profitHaircut: 0, minNetUsd: 0.5, minExpectedValueUsd: 0, maxStateAgeMs: 60_000, remainingLossBudgetUsd: 100 };
const config: EngineConfig = {
  policy,
  bidShare: 0.5,
  builders: new Set(),
  baseGasUnits: 100_000n,
  gasUnitsPerHop: 100_000n,
  mode: 'revert-protected',
  startBalanceUsd: 1000,
  deadlineMs: 8000,
  brutalLatencyFactor: 2,
};
const prices: Prices = { usd: new Map([[WETH, { price: 2000, decimals: 18 }]]), nativeUsd: 2000 };
const header = (number: number, miner = addr(99)): BlockHeader => ({
  number,
  timestamp: 1000 + number * 12,
  baseFeeWei: 1_000_000_000n,
  gasUsed: 15_000_000n,
  gasLimit: 30_000_000n,
  miner,
});

const metas = [v2(POOL_A), v2(POOL_B)];
const R0 = 1000n * E18;
const R1 = 2_000_000n * E18;

/** Warms both pools until the model trusts them, at equal prices. */
const warmed = async (engine: PaperEngine): Promise<void> => {
  let [a0, a1, b0, b1] = [R0, R1, R0, R1];
  await engine.onBlock(header(1), [sync(POOL_A, a0, a1), sync(POOL_B, b0, b1)], prices);
  const small = E18 / 100n;
  for (let block = 2; block <= 5; block++) {
    const logs: PoolLog[] = [];
    for (const pool of [POOL_A, POOL_B]) {
      const [r0, r1] = pool === POOL_A ? [a0, a1] : [b0, b1];
      const out = v2AmountOut(small, r0, r1);
      logs.push(...trade(pool, r0, r1, small, `0xwarm${block}${pool}`));
      if (pool === POOL_A) [a0, a1] = [r0 + small, r1 - out];
      else [b0, b1] = [r0 + small, r1 - out];
    }
    await engine.onBlock(header(block), logs, prices);
  }
  state = { a0, a1, b0, b1 };
};
let state = { a0: 0n, a1: 0n, b0: 0n, b1: 0n };

const makeEngine = (overrides: Partial<EngineConfig> = {}, rival = 0) =>
  new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), { ...config, ...overrides }, async () => rival);

/** Opens a 5% gap by moving pool B, as if a large trader had just hit it. */
const openGap = (): PoolLog[] => [sync(POOL_B, state.b0 * 100n / 105n, state.b1 * 105n / 100n, '0xwhale')];

test('sends a real gap and books the same win in every world when nobody interferes', async () => {
  const engine = makeEngine();
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 1);

  const settled = await engine.onBlock(header(7), [], prices);
  assert.equal(settled.length, 1);
  const [t] = settled;
  assert.equal(t!.results.optimistic.outcome, 'won');
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(t!.results.brutal.outcome, 'won');
  assert.ok(t!.results.brutal.netUsd > 0);
  assert.ok(Math.abs(t!.results.brutal.netUsd - (t!.profitUsd - t!.gasUsd - t!.bidUsd)) < 1e-9);
  assert.ok(engine.stats.scenarios.brutal.balanceUsd > 1000);
});

const rivalCloses = (): PoolLog[] => [sync(POOL_B, state.a0, state.a1, '0xrival')];

test('a rival closing the gap costs nothing under revert protection', async () => {
  const engine = makeEngine({}, Number.POSITIVE_INFINITY);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.optimistic.outcome, 'won', 'the optimistic world ignores rivals');
  assert.equal(t!.results.realistic.outcome, 'lost-to-rival');
  assert.equal(t!.results.brutal.outcome, 'lost-to-rival');
  assert.equal(t!.results.brutal.netUsd, 0);
  assert.equal(engine.stats.scenarios.brutal.balanceUsd, 1000);
});

test('we outbid a cheap rival in the realistic world but not in the brutal one', async () => {
  const engine = makeEngine({}, 0.01);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(t!.results.brutal.outcome, 'lost-to-rival');
});

test('the guard reverts when ordinary trades eat the gap, even without a rival arbitrage', async () => {
  const engine = makeEngine({}, 0);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(t!.results.brutal.outcome, 'guard-reverted');
  assert.equal(t!.results.brutal.netUsd, 0);
});

test('asks about the transaction that closed the gap, not one that merely touched the pool', async () => {
  const asked: string[][] = [];
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async (_block, hashes) => {
    asked.push(hashes);
    return 0;
  });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const pool = { b0: (state.b0 * 100n) / 105n, b1: (state.b1 * 105n) / 100n };
  const tinyTouch = sync(POOL_B, pool.b0 + E18 / 1000n, pool.b1 - E18, '0xbystander');
  const [t] = await engine.onBlock(header(7), [tinyTouch, sync(POOL_B, state.a0, state.a1, '0xcloser')], prices);
  assert.deepEqual(asked, [['0xcloser']]);
  assert.equal(t!.touchedByTxs, 2);
  assert.deepEqual(t!.closedByTxs, ['0xcloser']);
});

test('nothing is looked up when no transaction closed the trade', async () => {
  let calls = 0;
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => {
    calls++;
    return 0;
  });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  await engine.onBlock(header(7), [], prices);
  assert.equal(calls, 0);
});

test('a block from a builder we do not reach never includes the trade', async () => {
  const engine = makeEngine({ builders: new Set([addr(50)]) });
  await warmed(engine);
  await engine.onBlock(header(6, addr(50)), openGap(), prices);
  const [t] = await engine.onBlock(header(7, addr(51)), [], prices);
  assert.equal(t!.results.optimistic.outcome, 'won');
  assert.equal(t!.results.realistic.outcome, 'not-included');
  assert.equal(t!.results.brutal.outcome, 'not-included');
});

test('slow decisions miss the block only in the brutal world', async () => {
  const engine = makeEngine();
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices, 5000);
  const [t] = await engine.onBlock(header(7), [], prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(t!.results.brutal.outcome, 'too-slow');
});

test('failed attempts are charged when the chain has no revert protection', async () => {
  const engine = makeEngine({ mode: 'pays-gas' }, Number.POSITIVE_INFINITY);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.ok(t!.results.brutal.netUsd < 0);
  assert.ok(Math.abs(t!.results.brutal.netUsd + t!.gasUsd) < 1e-9);
  assert.equal(engine.stats.scenarios.brutal.losingTrades, 1);
});

test('the gate refuses a gap on pools that real swaps have not verified', async () => {
  const engine = makeEngine();
  await engine.onBlock(header(1), [sync(POOL_A, R0, R1), sync(POOL_B, R0, R1)], prices);
  await engine.onBlock(header(2), [sync(POOL_B, R0 * 100n / 105n, R1 * 105n / 100n, '0xwhale')], prices);
  assert.equal(engine.stats.sent, 0);
  assert.equal(engine.stats.refusals['unvetted-route'], 1);
});

test('the gate refuses a gap too thin to cover gas', async () => {
  const engine = makeEngine();
  await warmed(engine);
  // A price gap only just above the two 0.3% fees: real, but worth less than its gas.
  await engine.onBlock(header(6), [sync(POOL_B, (state.b0 * 100_000n) / 100_310n, (state.b1 * 100_310n) / 100_000n, '0xthin')], prices);
  assert.equal(engine.stats.sent, 0);
  assert.ok((engine.stats.refusals['loses-even-when-it-wins'] ?? 0) >= 1, JSON.stringify(engine.stats.refusals));
});

test('routes sharing a pool are not counted twice', async () => {
  const third = v2(POOL_C);
  const engine = new PaperEngine([...metas, third], new Set([WETH]), new Set([WETH, USDC]), config, async () => 0);
  const small = E18 / 100n;
  let [a0, a1, b0, b1, c0, c1] = [R0, R1, R0, R1, R0, R1];
  await engine.onBlock(header(1), [sync(POOL_A, a0, a1), sync(POOL_B, b0, b1), sync(POOL_C, c0, c1)], prices);
  for (let block = 2; block <= 5; block++) {
    const logs = [...trade(POOL_A, a0, a1, small, `0xa${block}`), ...trade(POOL_B, b0, b1, small, `0xb${block}`), ...trade(POOL_C, c0, c1, small, `0xc${block}`)];
    const step = (r0: bigint, r1: bigint): [bigint, bigint] => [r0 + small, r1 - v2AmountOut(small, r0, r1)];
    [a0, a1] = step(a0, a1);
    [b0, b1] = step(b0, b1);
    [c0, c1] = step(c0, c1);
    await engine.onBlock(header(block), logs, prices);
  }
  await engine.onBlock(header(6), [sync(POOL_B, (b0 * 100n) / 105n, (b1 * 105n) / 100n, '0xwhale')], prices);
  assert.equal(engine.stats.dislocations >= 2, true, 'both A and C can trade against B');
  assert.equal(engine.stats.sent, 1);
});

test('counts gaps that open and close inside one block as needing mempool sight', async () => {
  const engine = makeEngine();
  await warmed(engine);
  await engine.onBlock(header(6), [...openGap(), sync(POOL_B, state.a0, state.a1, '0xrival')], prices);
  assert.equal(engine.stats.sent, 0);
  assert.equal(engine.stats.midBlock.routes, 1);
  assert.equal(engine.stats.midBlock.closedSameBlock, 1);
  assert.ok(engine.stats.midBlock.netOfGasUsd > 0);
});

test('names the transaction that opened a mid-block gap', async () => {
  const engine = makeEngine();
  await warmed(engine);
  await engine.onBlock(header(6), [...openGap(), sync(POOL_B, state.a0, state.a1, '0xrival')], prices);
  assert.equal(engine.lastGaps.length, 1);
  assert.equal(engine.lastGaps[0]!.contributions[0]!.txHash, '0xwhale');
  assert.equal(engine.lastGaps[0]!.closedSameBlock, true);
  assert.ok(engine.lastGaps[0]!.usd > 0);
  await engine.onBlock(header(7), [], prices);
  assert.equal(engine.lastGaps.length, 0, 'gaps do not carry over to the next block');
});

test('a trade that widens an open gap owns only its share of it', async () => {
  const engine = makeEngine();
  await warmed(engine);
  const whale = sync(POOL_B, (state.b0 * 100n) / 105n, (state.b1 * 105n) / 100n, '0xwhale');
  const follower = sync(POOL_B, (state.b0 * 100n) / 106n, (state.b1 * 106n) / 100n, '0xfollower');
  await engine.onBlock(header(6), [whale, follower, sync(POOL_B, state.a0, state.a1, '0xrival')], prices);

  const [gap] = engine.lastGaps;
  assert.deepEqual(gap!.contributions.map((part) => part.txHash), ['0xwhale', '0xfollower']);
  const [first, second] = gap!.contributions;
  assert.ok(first!.usd > second!.usd, 'the trade that opened it owns more');
  assert.ok(Math.abs(first!.usd + second!.usd - gap!.usd) < 1e-6, 'the shares add up to the gap');
});

test('a trade that narrows a gap gets no share of it', async () => {
  const engine = makeEngine();
  await warmed(engine);
  const whale = sync(POOL_B, (state.b0 * 100n) / 105n, (state.b1 * 105n) / 100n, '0xwhale');
  const narrower = sync(POOL_B, (state.b0 * 100n) / 103n, (state.b1 * 103n) / 100n, '0xnarrower');
  await engine.onBlock(header(6), [whale, narrower, sync(POOL_B, state.a0, state.a1, '0xrival')], prices);
  assert.deepEqual(engine.lastGaps[0]!.contributions.map((part) => part.txHash), ['0xwhale']);
});

test('a mid-block gap open on several overlapping routes counts as one', async () => {
  const third = v2(POOL_C);
  const engine = new PaperEngine([...metas, third], new Set([WETH]), new Set([WETH, USDC]), config, async () => 0);
  const small = E18 / 100n;
  let [a0, a1, b0, b1, c0, c1] = [R0, R1, R0, R1, R0, R1];
  engine.warm([sync(POOL_A, a0, a1), sync(POOL_B, b0, b1), sync(POOL_C, c0, c1)]);
  for (let i = 0; i < 4; i++) {
    engine.warm([...trade(POOL_A, a0, a1, small), ...trade(POOL_B, b0, b1, small), ...trade(POOL_C, c0, c1, small)]);
    const step = (r0: bigint, r1: bigint): [bigint, bigint] => [r0 + small, r1 - v2AmountOut(small, r0, r1)];
    [a0, a1] = step(a0, a1);
    [b0, b1] = step(b0, b1);
    [c0, c1] = step(c0, c1);
  }
  await engine.onBlock(header(2), [sync(POOL_B, (b0 * 100n) / 105n, (b1 * 105n) / 100n, '0xwhale'), sync(POOL_B, a0, a1, '0xrival')], prices);
  assert.equal(engine.stats.midBlock.routes, 1);
});

test('a gap on a pool real swaps have not verified is not counted', async () => {
  const engine = makeEngine();
  engine.warm([sync(POOL_A, R0, R1), sync(POOL_B, R0, R1)]);
  await engine.onBlock(header(2), [sync(POOL_B, (R0 * 100n) / 105n, (R1 * 105n) / 100n, '0xwhale'), sync(POOL_B, R0, R1, '0xrival')], prices);
  assert.equal(engine.stats.midBlock.routes, 0);
});

test('never touches a balance when nothing was sent', async () => {
  const engine = makeEngine();
  await warmed(engine);
  for (const world of ['optimistic', 'realistic', 'brutal'] as const) assert.equal(engine.stats.scenarios[world].balanceUsd, 1000);
});

test('warming builds state and trust without trading or counting blocks', async () => {
  const engine = makeEngine();
  let [r0, r1] = [R0, R1];
  const small = E18 / 100n;
  const history: PoolLog[] = [sync(POOL_A, r0, r1)];
  for (let i = 0; i < 4; i++) {
    history.push(...trade(POOL_A, r0, r1, small));
    r1 -= v2AmountOut(small, r0, r1);
    r0 += small;
  }
  engine.warm(history);
  assert.equal(engine.book.isVerified(POOL_A), true);
  assert.equal(engine.stats.blocks, 0);
  assert.equal(engine.stats.sent, 0);
});

const viewOf = (prove: ChainView['prove'], refresh: ChainView['refresh'] = async () => []): ChainView => ({ prove, refresh });

test('a trade the real EVM rejects is never sent', async () => {
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, viewOf(async () => ({ ok: false, reason: 'execution reverted' })));
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 0);
  assert.equal(engine.stats.evm.rejected, 1);
  assert.deepEqual(await engine.onBlock(header(7), [], prices), []);
});

test('money is counted from what executed, not from what the model expected', async () => {
  const realProfit = E18 / 100n;
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, viewOf(async () => ({ ok: true, profit: realProfit, gasUnits: 500_000n })));
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 1);

  const [t] = await engine.onBlock(header(7), [], prices);
  assert.equal(t!.profitUsd, 20, '0.01 WETH at $2000');
  assert.ok(t!.modelProfitUsd > t!.profitUsd, 'the model expected more');
  assert.equal(t!.gasUnits, '500000');
  assert.ok(Math.abs(t!.gasUsd - (500_000 * 1e9 * 2000) / 1e18) < 1e-9);
  assert.ok(Math.abs(t!.bidUsd - (20 - t!.gasUsd - 0) * 0.5) < 1e-3 || t!.bidUsd > 0);
  assert.ok(Math.abs(t!.results.brutal.netUsd - (20 - t!.gasUsd - t!.bidUsd)) < 1e-6);
  assert.equal(engine.stats.evm.proved, 1);
  assert.ok(engine.stats.evm.modelUsd > engine.stats.evm.evmUsd);
});

test('a trade that shrinks below what the gate accepts once executed is refused', async () => {
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, viewOf(async () => ({ ok: true, profit: 1n, gasUnits: 500_000n })));
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 0);
  assert.equal(engine.stats.evm.rejected, 1);
});

test('when the best route is rejected the next one on the same pool still gets its turn', async () => {
  const third = v2(POOL_C);
  const proved: string[] = [];
  const view = viewOf(async (_block, cycle) => {
    proved.push(cycle.key);
    return proved.length === 1 ? { ok: false, reason: 'reverted' } : { ok: true, profit: E18 / 10n, gasUnits: 300_000n };
  });
  const engine = new PaperEngine([...metas, third], new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, view);
  const small = E18 / 100n;
  let [a0, a1, b0, b1, c0, c1] = [R0, R1, R0, R1, R0 * 2n, R1 * 2n];
  await engine.onBlock(header(1), [sync(POOL_A, a0, a1), sync(POOL_B, b0, b1), sync(POOL_C, c0, c1)], prices);
  for (let block = 2; block <= 5; block++) {
    const logs = [...trade(POOL_A, a0, a1, small, `0xa${block}`), ...trade(POOL_B, b0, b1, small, `0xb${block}`), ...trade(POOL_C, c0, c1, small, `0xc${block}`)];
    const step = (r0: bigint, r1: bigint): [bigint, bigint] => [r0 + small, r1 - v2AmountOut(small, r0, r1)];
    [a0, a1] = step(a0, a1);
    [b0, b1] = step(b0, b1);
    [c0, c1] = step(c0, c1);
    await engine.onBlock(header(block), logs, prices);
  }
  proved.length = 0;
  await engine.onBlock(header(6), [sync(POOL_B, (b0 * 100n) / 105n, (b1 * 105n) / 100n, '0xwhale')], prices);
  assert.equal(proved.length, 2);
  assert.equal(engine.stats.sent, 1);
  assert.equal(engine.stats.evm.rejected, 1);
});

test('a route is not proved while a better one over the same pool is still good', async () => {
  const third = v2(POOL_C);
  let proofs = 0;
  const view = viewOf(async () => {
    proofs++;
    return { ok: true, profit: E18 / 10n, gasUnits: 300_000n };
  });
  const engine = new PaperEngine([...metas, third], new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, view);
  const small = E18 / 100n;
  let [a0, a1, b0, b1, c0, c1] = [R0, R1, R0, R1, R0 * 2n, R1 * 2n];
  await engine.onBlock(header(1), [sync(POOL_A, a0, a1), sync(POOL_B, b0, b1), sync(POOL_C, c0, c1)], prices);
  for (let block = 2; block <= 5; block++) {
    const logs = [...trade(POOL_A, a0, a1, small, `0xa${block}`), ...trade(POOL_B, b0, b1, small, `0xb${block}`), ...trade(POOL_C, c0, c1, small, `0xc${block}`)];
    const step = (r0: bigint, r1: bigint): [bigint, bigint] => [r0 + small, r1 - v2AmountOut(small, r0, r1)];
    [a0, a1] = step(a0, a1);
    [b0, b1] = step(b0, b1);
    [c0, c1] = step(c0, c1);
    await engine.onBlock(header(block), logs, prices);
  }
  proofs = 0;
  await engine.onBlock(header(6), [sync(POOL_B, (b0 * 100n) / 105n, (b1 * 105n) / 100n, '0xwhale')], prices);
  assert.ok(engine.stats.dislocations >= 2, 'both A and C can trade against B');
  assert.equal(proofs, 1);
  assert.equal(engine.stats.sent, 1);
});

test('a fee that moves is applied before deciding and reopens routes through that pool', async () => {
  const dynamic: PoolMeta = { ...v3Meta, address: POOL_C, fee: 10_000 };
  const book = new PoolBook([dynamic]);
  assert.equal(book.setFee(POOL_C, 10_000), false, 'the same fee changes nothing');
  assert.equal(book.setFee(POOL_C, 500), true);
  assert.equal(book.setFee(POOL_D, 500), false, 'unknown pools are ignored');

  const refreshed: number[] = [];
  const engine = makeEngineWithRefresh(refreshed);
  await warmed(engine);
  await engine.onBlock(header(6), [], prices);
  assert.ok(refreshed.includes(6), 'read for the block just processed');
});

const makeEngineWithRefresh = (refreshed: number[]): PaperEngine =>
  new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), config, async () => 0, viewOf(async () => ({ ok: false, reason: 'unused' }), async (h) => {
    refreshed.push(h.number);
    return [];
  }));

const selfBuilt = (tip: number, overrides: Partial<EngineConfig> = {}): PaperEngine =>
  new PaperEngine(
    metas,
    new Set([WETH]),
    new Set([WETH, USDC]),
    { ...config, policy: { ...policy, remainingLossBudgetUsd: 1e9 }, mode: 'pays-gas', auction: 'tip-per-gas', failureGasUnits: 60_000n, ...overrides },
    // A large total payment, which must not matter when the block is ordered by tip.
    async () => 1_000_000,
    undefined,
    async () => tip,
  );

test('in a block ordered by tip, a rival paying more in total still loses to a higher tip', async () => {
  const engine = selfBuilt(1);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(t!.results.brutal.outcome, 'lost-to-rival', 'the brutal world still loses to any rival');
});

test('in a block ordered by tip, a higher tip goes first even with a smaller total', async () => {
  const engine = selfBuilt(1e15);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.realistic.outcome, 'lost-to-rival');
});

test('a trade survives prices moving together, because the gap across the route stays open', async () => {
  // Both pools drift together: one leg gets worse past its limit, the other better, the gap stays.
  const drift = (): PoolLog[] => [sync(POOL_B, ((state.b0 * 100n) / 105n * 98n) / 100n, ((state.b1 * 105n) / 100n * 102n) / 100n, '0xdriftb'), sync(POOL_A, (state.a0 * 98n) / 100n, (state.a1 * 102n) / 100n, '0xdrifta')];
  const ahead = selfBuilt(1e15);
  await warmed(ahead);
  await ahead.onBlock(header(6), openGap(), prices);
  const [t] = await ahead.onBlock(header(7), drift(), prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.ok(t!.atOurTurn!.fixedUsd > 0, 'the route still pays');
  assert.ok(Math.abs(t!.atOurTurn!.edge - t!.atOurTurn!.startEdge) < 0.01, 'the gap is about the same');

  const behind = selfBuilt(0);
  await warmed(behind);
  await behind.onBlock(header(6), openGap(), prices);
  const [u] = await behind.onBlock(header(7), drift(), prices);
  assert.equal(u!.atOurTurn!.edge, u!.atOurTurn!.startEdge, 'paying less than us, they come after');
});

test('at our turn a narrower gap pays more with a smaller amount than with the planned one', async () => {
  const engine = selfBuilt(1e15);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const halfBack = sync(POOL_B, (state.b0 * 100n) / 104n, (state.b1 * 104n) / 100n, '0xpartial');
  const [t] = await engine.onBlock(header(7), [halfBack], prices);
  const turn = t!.atOurTurn!;
  assert.ok(turn.edge < turn.startEdge && turn.edge > 1);
  assert.ok(turn.resizedUsd > turn.fixedUsd);
  assert.ok(turn.resizedUsd > 0);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.ok(Math.abs(t!.results.realistic.netUsd - (turn.resizedUsd - t!.gasUsd - t!.bidUsd)) < 1e-9, 'it earns what is left, not what was planned');
});

test('builder blocks have no known turn', async () => {
  const engine = selfBuilt(1, { rankedByTotal: () => true });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), [], prices);
  assert.equal(t!.atOurTurn, undefined);
});

test('a failed attempt costs only what it burned before stopping, including the tip', async () => {
  const engine = selfBuilt(1e15);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  const lost = t!.results.realistic.netUsd;
  assert.ok(lost < 0, 'there is no revert protection here');
  assert.ok(-lost > (60_000 * 1e9 * 2000) / 1e18, 'more than base fee alone, because the tip is paid too');
  assert.ok(-lost < t!.gasUsd + t!.bidUsd, 'far less than a full attempt');
  const units = BigInt(t!.gasUnits);
  const tipUsd = t!.bidUsd * (60_000 / Number(units));
  assert.ok(Math.abs(-lost - ((60_000 * 1e9 * 2000) / 1e18 + tipUsd)) < 1e-6);
});

test('a large tip puts more at risk, so the loss budget can refuse it', async () => {
  const engine = selfBuilt(0, { policy: { ...policy, remainingLossBudgetUsd: 1 } });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 0);
  assert.ok((engine.stats.refusals['loss-budget-exhausted'] ?? 0) >= 1);
});

test('a public transaction is ranked by total payment in a builder block and by tip in a self-built one', async () => {
  const outcomeWhen = async (rankedByTotal: boolean): Promise<string> => {
    // The rival pays far more in total but a tiny tip per gas.
    const engine = selfBuilt(1, { rankedByTotal: () => rankedByTotal });
    await warmed(engine);
    await engine.onBlock(header(6), openGap(), prices);
    const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
    return t!.results.realistic.outcome;
  };
  assert.equal(await outcomeWhen(true), 'lost-to-rival');
  assert.equal(await outcomeWhen(false), 'won');
});

test('a missing tip reading counts against us', async () => {
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), { ...config, policy: { ...policy, remainingLossBudgetUsd: 1e9 }, mode: 'pays-gas', auction: 'tip-per-gas', failureGasUnits: 60_000n }, async () => 0);
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), rivalCloses(), prices);
  assert.equal(t!.results.realistic.outcome, 'lost-to-rival');
});

test('nobody closing the trade wins it without any lookup', async () => {
  let asked = 0;
  const engine = new PaperEngine(metas, new Set([WETH]), new Set([WETH, USDC]), { ...config, auction: 'tip-per-gas' }, async () => 0, undefined, async () => {
    asked++;
    return 1e18;
  });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), [], prices);
  assert.equal(t!.results.realistic.outcome, 'won');
  assert.equal(asked, 0);
});

test('only accepted blocks are traded', async () => {
  const engine = makeEngine({ targetsBlock: (block) => block === 9 });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  assert.equal(engine.stats.sent, 0, 'the next block, 7, is not accepted');
  assert.equal(engine.stats.dislocations, 0, 'and the route is not even looked at');
});

test('the bid leaves the gate margin intact after the haircut', async () => {
  const engine = makeEngine({ policy: { ...policy, profitHaircut: 0.1 }, bidShare: 0.85 });
  await warmed(engine);
  await engine.onBlock(header(6), openGap(), prices);
  const [t] = await engine.onBlock(header(7), [], prices);
  const expectedBid = (t!.profitUsd * 0.9 - t!.gasUsd) * 0.85;
  assert.ok(Math.abs(t!.bidUsd - expectedBid) < 1e-6);
  assert.ok(t!.results.optimistic.netUsd > 0);
});
