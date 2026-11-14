import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SentTrade } from '../src/paper/engine.ts';
import type { PoolMeta } from '../src/paper/pools.ts';
import type { Rpc } from '../src/rpc.ts';
import { broadcast, type NodeAnswer } from '../src/sender/broadcast.ts';
import type { BundleCheck } from '../src/sender/bundle-check.ts';
import { classifyReceipt, LiveSender } from '../src/sender/live.ts';
import { DEFAULT_LIMITS, newRiskState, RiskGuard, type RiskLimits } from '../src/sender/risk.ts';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TREASURY = '0x00000000000000000000000000000000000beef0';
const POOL_A = '0x00000000000000000000000000000000000000a1';
const POOL_B = '0x00000000000000000000000000000000000000b2';
const NOW = Date.UTC(2026, 10, 4, 12);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const metas = new Map<string, PoolMeta>(
  [POOL_A, POOL_B].map((address) => [address, { address, kind: 'v3', token0: USDC, token1: WETH, fee: 500, tickSpacing: 10 }]),
);
const sent = (overrides: Partial<SentTrade> = {}): SentTrade => ({
  decidedAtBlock: 500,
  route: [WETH, USDC],
  pools: [POOL_A, POOL_B],
  amountIn: 10n ** 18n,
  pricesAtDecision: [1n, 2n],
  startGap: 10n ** 16n,
  profitUsd: 10,
  bidUsd: 0.5,
  gasUnits: 400_000n,
  usdPerUnit: 2000 / 1e18,
  ...overrides,
});
const context = { nextBaseFeeWei: 200_000_000n, nativeUsd: 2000, timestamp: NOW / 1000 - 3, minNetUsd: 0.25, failureGasUnits: 60_000n };

interface Harness {
  sender: LiveSender;
  guard: RiskGuard;
  broadcasted: string[];
  run: () => Promise<void>;
  receipts: Map<string, unknown>;
  dir: string;
  stopFile: string;
  stateFile: string;
  logFile: string;
  done: () => Promise<void>;
  /** While true, the node fails every question about the sender's account. */
  nodeDown: { value: boolean };
}

const harness = async (options: { balanceWei?: bigint; limits?: Partial<RiskLimits>; refuseBroadcast?: boolean; needTipWei?: (trade: SentTrade) => bigint; say?: (line: string) => void; failuresPerWin?: (blockTimestamp: number) => number; slotTakesPublic?: (blockTimestamp: number) => boolean; sendBundle?: (txs: readonly `0x${string}`[], targetBlock: number) => Promise<NodeAnswer[]>; checkBundle?: (txs: readonly `0x${string}`[], targetBlock: number) => Promise<BundleCheck>; traceBundle?: (answers: NodeAnswer[], targetBlock: number) => Promise<Record<string, unknown> | null> } = {}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'cryptome-live-'));
  const guard = new RiskGuard({ ...DEFAULT_LIMITS, ...options.limits }, newRiskState(NOW));
  const broadcasted: string[] = [];
  const receipts = new Map<string, unknown>();
  let scheduled: (() => void) | null = null;
  let counter = 0;
  const nodeDown = { value: false };
  const node: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (nodeDown.value && (method === 'eth_getBalance' || method === 'eth_getTransactionCount')) throw new Error('HTTP 503');
      if (method === 'eth_getBalance') return `0x${(options.balanceWei ?? 10n ** 18n).toString(16)}` as T;
      if (method === 'eth_getTransactionCount') return '0x7' as T;
      if (method === 'eth_sendRawTransaction') {
        if (options.refuseBroadcast) throw new Error('refused');
        broadcasted.push(params[0] as string);
        return `0xhash${counter++}` as T;
      }
      if (method === 'eth_getTransactionReceipt') {
        const receipt = receipts.get(params[0] as string);
        if (!receipt) throw new Error('empty result');
        return receipt as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const stopFile = join(dir, 'STOP');
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'log.jsonl');
  const sender = new LiveSender({
    rpc: node,
    broadcast: [{ name: 'test', rpc: node }],
    account: privateKeyToAccount(generatePrivateKey()),
    executor: '0x00000000000000000000000000000000c0ffee01',
    treasury: TREASURY,
    chainId: 1,
    metas,
    wrappedNative: WETH,
    guard,
    stateFile,
    logFile,
    stopFile,
    reserveWei: 10n ** 15n,
    ...(options.needTipWei ? { needTipWei: options.needTipWei } : {}),
    ...(options.failuresPerWin ? { failuresPerWin: options.failuresPerWin } : {}),
    ...(options.slotTakesPublic ? { slotTakesPublic: options.slotTakesPublic } : {}),
    ...(options.sendBundle ? { sendBundle: options.sendBundle } : {}),
    ...(options.checkBundle ? { checkBundle: options.checkBundle } : {}),
    ...(options.traceBundle ? { traceBundle: options.traceBundle } : {}),
    resultsFile: join(dir, 'results.csv'),
    blockKindOf: () => 'validator',
    say: options.say ?? (() => {}),
    now: () => NOW,
    schedule: (fn) => {
      scheduled = fn;
    },
  });
  return {
    sender,
    guard,
    broadcasted,
    receipts,
    dir,
    stopFile,
    stateFile,
    logFile,
    run: async () => {
      scheduled?.();
      scheduled = null;
      // The send runs on its own after signing, so give it a moment to finish.
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    done: () => rm(dir, { recursive: true, maxRetries: 5 }),
    nodeDown,
  };
};

const receipt = (status: string, gasUsed: bigint, logs: { address: string; topics: string[]; data: string }[] = []) => ({ status, gasUsed: `0x${gasUsed.toString(16)}`, effectiveGasPrice: '0x3b9aca00', logs });
const treasuryLog = (amount: bigint) => ({ address: WETH, topics: [TRANSFER, `0x${'0'.repeat(64)}`, `0x${TREASURY.slice(2).padStart(64, '0')}`], data: `0x${amount.toString(16)}` });

const wethOnly = { treasury: TREASURY, usdPerUnit: new Map([[WETH, 2000 / 1e18]]), routes: 1 };

test('a mined success is valued by what reached the treasury, less what the transaction cost', () => {
  const result = classifyReceipt(receipt('0x1', 400_000n, [treasuryLog(10n ** 16n)]), wethOnly, 2000);
  assert.equal(result.kind, 'won');
  assert.ok(result.kind === 'won' && Math.abs(result.netUsd - (20 - 0.8)) < 1e-9);
});

test('a batch is valued by everything that reached the treasury, in every token', () => {
  const usdc = { ...treasuryLog(5_000_000n), address: USDC };
  const usdPerUnit = new Map([[WETH, 2000 / 1e18], [USDC, 1 / 1e6]]);
  const result = classifyReceipt(receipt('0x1', 400_000n, [treasuryLog(10n ** 16n), treasuryLog(10n ** 16n), usdc]), { treasury: TREASURY, usdPerUnit, routes: 3 }, 2000);
  assert.ok(result.kind === 'won' && Math.abs(result.netUsd - (20 + 20 + 5 - 0.8)) < 1e-9);
});

test('a success that paid the treasury nothing counts as a loss, not a win in name only', () => {
  const result = classifyReceipt(receipt('0x1', 400_000n), wethOnly, 2000);
  assert.ok(result.kind === 'won' && result.netUsd < 0);
});

test('a revert is cheap when it stopped at the check and costly when it got further', () => {
  assert.equal(classifyReceipt(receipt('0x0', 55_000n), wethOnly, 2000).kind, 'stopped-early');
  assert.equal(classifyReceipt(receipt('0x0', 300_000n), wethOnly, 2000).kind, 'costly-failure');
});

test('a batch stopped at its checks burns more gas without that meaning the model was wrong', () => {
  assert.equal(classifyReceipt(receipt('0x0', 130_000n), wethOnly, 2000).kind, 'costly-failure');
  assert.equal(classifyReceipt(receipt('0x0', 130_000n), { ...wethOnly, routes: 3 }, 2000).kind, 'stopped-early');
});

test('it sends one signed transaction at its moment, carrying everything the block offers', async () => {
  const h = await harness();
  await h.sender.propose([sent({ profitUsd: 5 }), sent({ profitUsd: 20 }), sent({ profitUsd: 7 })], context);
  assert.equal(h.broadcasted.length, 0, 'nothing leaves before its moment');
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  assert.ok(h.broadcasted[0]!.startsWith('0x02'), 'a signed EIP-1559 transaction');
  const log = await readFile(h.logFile, 'utf8');
  assert.ok(log.includes('"routes":3') && log.includes('"profitUsd":32'));
  await h.done();
});

test('a batch too big for the balance falls back to its best route', async () => {
  // Enough for one route's gas and the reserve, not for three.
  const h = await harness({ balanceWei: 10n ** 15n + 400_000_000_000_000n });
  await h.sender.propose([sent({ profitUsd: 20 }), sent({ profitUsd: 19 }), sent({ profitUsd: 18 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  assert.ok((await readFile(h.logFile, 'utf8')).includes('"routes":1'));
  await h.done();
});

const firstSent = async (h: Harness): Promise<{ routes: number; tipWeiPerGas: string; gasLimit: string; failureCostUsd: number }> =>
  JSON.parse((await readFile(h.logFile, 'utf8')).split('\n').find((line) => line.includes('"event":"sent"'))!);
const huge = { profitUsd: 2000, bidUsd: 100 };

test('a huge trade goes with a lower bid when its usual bid would break the limit on one attempt', async () => {
  const h = await harness();
  await h.sender.propose([sent(huge)], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1, 'its 5% bid alone would burn $15 on a failure');
  const logged = await firstSent(h);
  assert.ok(logged.failureCostUsd <= DEFAULT_LIMITS.maxAttemptFailureUsd);
  assert.ok(BigInt(logged.tipWeiPerGas) > 10_000_000_000n, 'and still bids as much as fits');
  await h.done();
});

test('a huge trade goes with a lower bid when its usual bid would not fit the balance', async () => {
  const balanceWei = 6n * 10n ** 15n;
  const h = await harness({ balanceWei });
  await h.sender.propose([sent(huge)], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  const logged = await firstSent(h);
  const fee = BigInt(logged.tipWeiPerGas) + context.nextBaseFeeWei;
  assert.ok(BigInt(logged.gasLimit) * fee + 10n ** 15n <= balanceWei, 'gas and the reserve both fit');
  await h.done();
});

test('the lower bid holds when a rival shuts one route at the last look', async () => {
  const h = await harness({ needTipWei: (trade) => (trade.pools[0] === POOL_A ? 50_000_000_000n : 0n) });
  await h.sender.propose([sent(huge), sent({ ...huge, pools: [POOL_B, POOL_B] })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  const logged = await firstSent(h);
  assert.equal(logged.routes, 1, 'beating that rival would break the limit, so only the open route goes');
  assert.ok(logged.failureCostUsd <= DEFAULT_LIMITS.maxAttemptFailureUsd, 'and it does not go back to the full bid');
  await h.done();
});

test('a trade too small for the odds of its slot stays home and burns nothing', async () => {
  const unlikely = await harness({ needTipWei: () => 0n, failuresPerWin: () => 5000 });
  await unlikely.sender.propose([sent()], context);
  await unlikely.run();
  assert.equal(unlikely.broadcasted.length, 0);
  assert.equal(unlikely.sender.summary.refused['not-worth-sending'], 1);
  await unlikely.done();

  const likely = await harness({ needTipWei: () => 0n, failuresPerWin: () => 2 });
  await likely.sender.propose([sent()], context);
  await likely.run();
  assert.equal(likely.broadcasted.length, 1);
  assert.equal((await firstSent(likely) as unknown as { failuresPerWin: number }).failuresPerWin, 2, 'the odds it went on are on record');
  await likely.done();
});

test('a trade of any size goes publicly only into a nearly sure slot', async () => {
  const unsure = await harness({ slotTakesPublic: () => false });
  await unsure.sender.propose([sent({ profitUsd: 20 })], context);
  await unsure.run();
  assert.equal(unsure.broadcasted.length, 0, 'nothing signed, nothing burned');
  assert.equal(unsure.sender.summary.refused['unlikely-slot'], 1);
  assert.ok((await readFile(unsure.logFile, 'utf8')).includes('"profitUsd":20'), 'what it passed up stays on record');
  await unsure.done();

  const sure = await harness({ slotTakesPublic: () => true });
  await sure.sender.propose([sent({ profitUsd: 20 })], context);
  await sure.run();
  assert.equal(sure.broadcasted.length, 1);
  await sure.done();

  // The $354 trade of 2026-11-05 went public into a builder block and lost $1.16.
  const large = await harness({ slotTakesPublic: () => false });
  await large.sender.propose([sent({ profitUsd: 300 }), sent({ profitUsd: 54 })], context);
  await large.run();
  assert.equal(large.broadcasted.length, 0, 'worth $354 in all, and still not public');
  assert.equal(large.sender.summary.refused['unlikely-slot'], 1);
  await large.done();
});

const bundleHarness = async (options: { slotTakesPublic?: () => boolean; refuseBroadcast?: boolean } = {}): Promise<Harness & { signed: `0x${string}`[]; targets: number[]; bundles: (readonly `0x${string}`[])[] }> => {
  const signed: `0x${string}`[] = [];
  const targets: number[] = [];
  const bundles: (readonly `0x${string}`[])[] = [];
  const h = await harness({ slotTakesPublic: options.slotTakesPublic ?? (() => false), sendBundle: async (txs, target) => { bundles.push(txs); signed.push(txs.at(-1)!); targets.push(target); return [{ name: 'builder', ok: true, ms: 1 }]; } });
  return Object.assign(h, { signed, targets, bundles });
};

test('in an unlikely slot a trade goes privately, and nothing reaches the public mempool', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0, 'public sending would burn gas on a failure');
  assert.equal(h.signed.length, 1);
  assert.equal(h.targets[0], 501, 'good for the next block only');
  assert.equal(h.sender.summary.refused['unlikely-slot'], undefined);
  await h.done();
});

test('each bundle is checked at the top of its block, and a check that could not run is kept apart', async () => {
  const checked: { txs: readonly `0x${string}`[]; target: number }[] = [];
  let answer: () => Promise<BundleCheck> = async () => ({ ok: false, reason: 'execution reverted: IG', gasUsed: 50_000 });
  const h = await harness({
    slotTakesPublic: () => false,
    sendBundle: async () => [{ name: 'builder', ok: true, ms: 1 }],
    checkBundle: (txs, target) => {
      checked.push({ txs, target });
      return answer();
    },
  });
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  answer = async () => {
    throw new Error('HTTP 429');
  };
  await h.sender.propose([sent({ profitUsd: 20, decidedAtBlock: 501 })], context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(checked.map((check) => [check.txs.length, check.target]), [[1, 501], [1, 502]]);
  const log = (await readFile(h.logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const checks = log.filter((entry) => entry.event === 'bundle-check');
  const bundle = log.find((entry) => entry.event === 'bundle')!;
  assert.deepEqual(checks[0], { event: 'bundle-check', hash: bundle.hash, ok: false, reason: 'execution reverted: IG', gasUsed: 50_000 });
  assert.equal(checks[1]!.error, 'HTTP 429');
  assert.equal(checks[1]!.ok, undefined, 'not counted as a failed bundle');
  await h.done();
});

test('what a builder says of a bundle is kept, and a builder that cannot say does no harm', async () => {
  const asked: { answers: NodeAnswer[]; target: number }[] = [];
  const h = await harness({
    slotTakesPublic: () => false,
    sendBundle: async () => [{ name: 'eureka', ok: true, ms: 1, bundleHash: '0xb1' } as NodeAnswer],
    traceBundle: async (answers, target) => {
      asked.push({ answers, target });
      if (target === 501) return { builder: 'eureka', status: 'ExcludedFromBlock' };
      throw new Error('bundle 0xb1 not found');
    },
  });
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.sender.propose([sent({ profitUsd: 20, decidedAtBlock: 501 })], context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked.map(({ answers, target }) => [(answers[0] as NodeAnswer & { bundleHash?: string }).bundleHash, target]), [['0xb1', 501], ['0xb1', 502]]);
  const traces = (await readFile(h.logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'bundle-trace');
  assert.equal(traces[0]!.status, 'ExcludedFromBlock');
  assert.equal(traces[1]!.error, 'bundle 0xb1 not found');
  assert.equal(h.sender.summary.sendErrors, 0);
  await h.done();
});

test('a large trade in an unlikely slot goes privately too', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 300 }), sent({ profitUsd: 54 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.signed.length, 1);
  await h.done();
});

test('a bundle offers a quarter of its profit, and the contract still keeps what covers the costs', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.run();
  const tx = parseTransaction(h.signed[0]!);
  // $5 over 400k gas at $2000 is 6.25 gwei.
  assert.equal(tx.maxPriorityFeePerGas, 6_250_000_000n);
  await h.done();
});

test('a bundle for an even block offers 60%, so two bids can be compared on live blocks', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20, decidedAtBlock: 501 })], context);
  await h.run();
  const tx = parseTransaction(h.signed[0]!);
  // $12 over 400k gas at $2000 is 15 gwei.
  assert.equal(tx.maxPriorityFeePerGas, 15_000_000_000n);
  assert.equal(h.targets[0], 502);
  const bundle = (await readFile(h.logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'bundle')!;
  assert.equal(bundle.bidShare, 0.6, 'each bundle says which bid it carried');
  await h.done();
});

test('a bundle that does not land costs nothing and blocks nothing', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.run();
  const before = h.guard.state.totalNetUsd;
  await h.sender.onBlock(501);
  await h.sender.onBlock(502);
  assert.equal(h.guard.state.totalNetUsd, before, 'no loss on record');
  assert.equal(h.guard.state.recentFailures.length, 0);
  await h.sender.propose([sent({ decidedAtBlock: 502, profitUsd: 20 })], context);
  await h.run();
  assert.equal(h.signed.length, 2, 'the next one goes at once');
  const nonces = h.signed.map((tx) => parseTransaction(tx).nonce);
  assert.equal(nonces[0], nonces[1], 'and reuses the nonce, as nothing was spent');
  await h.done();
});

test('a bundle that lands is settled like any win, and the next attempt moves past its nonce', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.run();
  h.receipts.set(keccak256(h.signed[0]!), receipt('0x1', 400_000n, [treasuryLog(10n ** 16n)]));
  await h.sender.onBlock(501);
  assert.equal(h.sender.summary.bundlesLanded, 1);
  assert.equal(h.sender.summary.won, 1);
  assert.ok(h.guard.state.totalNetUsd > 0);
  assert.ok((await readFile(h.logFile, 'utf8')).includes('"bundle":true'));
  await h.sender.propose([sent({ decidedAtBlock: 501, profitUsd: 20 })], context);
  await h.run();
  assert.equal(parseTransaction(h.signed[1]!).nonce, parseTransaction(h.signed[0]!).nonce! + 1);
  await h.done();
});

test('the limits and the stop file hold for bundles too', async () => {
  const halted = await bundleHarness();
  halted.guard.state.haltReason = 'test';
  await halted.sender.propose([sent({ profitUsd: 20 })], context);
  await halted.run();
  assert.equal(halted.signed.length, 0);
  await halted.done();

  const stopped = await bundleHarness();
  await writeFile(stopped.stopFile, '');
  await stopped.sender.propose([sent({ profitUsd: 20 })], context);
  await stopped.run();
  assert.equal(stopped.signed.length, 0);
  await rm(stopped.stopFile);
  await stopped.done();
});

test('a nearly sure slot still goes in public, where a self-built block can see it', async () => {
  const h = await bundleHarness({ slotTakesPublic: () => true });
  await h.sender.propose([sent({ profitUsd: 20 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  assert.equal(h.signed.length, 0);
  await h.done();
});

test('a public place is not taken in an unlikely slot, where it would only burn gas', async () => {
  const h = await bundleHarness();
  await h.sender.propose([sent({ profitUsd: 20 })], context, { tipWei: 500_000_000n });
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.signed.length, 0);
  await h.done();
});

test('a trade behind a pending transaction goes in one bundle with it, that transaction first', async () => {
  const h = await bundleHarness();
  const opener = '0x02abcdef' as const;
  await h.sender.proposeBackrunBundle([sent({ profitUsd: 20 })], context, opener);
  assert.equal(h.broadcasted.length, 0, 'nothing public');
  assert.equal(h.bundles[0]!.length, 2);
  assert.equal(h.bundles[0]![0], opener);
  assert.equal(parseTransaction(h.bundles[0]![1]!).nonce, 7, 'ours comes right behind it');
  assert.ok((await readFile(h.logFile, 'utf8')).includes(keccak256(opener)), 'the log says whom it followed');
  await h.done();
});

test('a pending trade respects the stop file and quarantine as well', async () => {
  const stopped = await bundleHarness();
  await writeFile(stopped.stopFile, '');
  await stopped.sender.proposeBackrunBundle([sent({ profitUsd: 20 })], context, '0x02abcdef');
  assert.equal(stopped.bundles.length, 0);
  await rm(stopped.stopFile);
  await stopped.done();

  const quarantined = await bundleHarness();
  quarantined.guard.state.quarantinedUntil[POOL_A] = NOW + 1000;
  await quarantined.sender.proposeBackrunBundle([sent({ profitUsd: 20 })], context, '0x02abcdef');
  assert.equal(quarantined.bundles.length, 0);
  await quarantined.done();
});

test('a route through a quarantined pool stays out, and the others still go', async () => {
  const h = await harness();
  h.guard.state.quarantinedUntil[POOL_A] = NOW + 1000;
  await h.sender.propose([sent({ profitUsd: 20 }), sent({ pools: [POOL_B, POOL_B], profitUsd: 5 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  assert.ok((await readFile(h.logFile, 'utf8')).includes('"routes":1'));
  await h.sender.onBlock(600);
  await h.done();
});

test('the key never reaches the log', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  const text = await readFile(h.logFile, 'utf8');
  assert.ok(!/privateKey|0x[0-9a-f]{64}/i.test(text));
  await h.done();
});

test('a stop file blocks sending at once, even for an attempt already waiting', async () => {
  const h = await harness();
  await writeFile(h.stopFile, '');
  await h.sender.propose([sent()], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['stop-file'], 1);
  await rm(h.stopFile);

  await h.sender.propose([sent()], context);
  await writeFile(h.stopFile, '');
  await h.run();
  assert.equal(h.broadcasted.length, 0, 'it appeared while waiting');
  await h.done();
});

test('an attempt still in the running keeps its nonce', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.sender.propose([sent()], context);
  assert.equal(h.sender.summary.refused['attempt-in-flight'], 1, 'waiting to go out');
  await h.run();
  await h.sender.propose([sent()], context);
  assert.equal(h.sender.summary.refused['attempt-in-flight'], 2, 'out, and its block has not passed');
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  await h.done();
});

test('it refuses to send when the balance could not cover the attempt and a cancellation', async () => {
  const h = await harness({ balanceWei: 10n ** 14n });
  await h.sender.propose([sent()], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['balance-too-low'], 1);
  await h.done();
});

test('the risk limits decide before anything is signed', async () => {
  const h = await harness({ limits: { maxAttemptFailureUsd: 0.0001 } });
  await h.sender.propose([sent()], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['attempt-too-costly'], 1);
  const refusal = JSON.parse((await readFile(h.logFile, 'utf8')).trim().split('\n').find((line) => line.includes('"refused"'))!);
  assert.equal(refusal.profitUsd, 10, 'a refusal records what the trade was worth');
  assert.equal(refusal.targetBlock, 501);
  await h.done();
});

test('a finished attempt is shown plainly and added to the record', async () => {
  const lines: string[] = [];
  const h = await harness({ say: (line) => lines.push(line) });
  await h.sender.propose([sent()], context);
  await h.run();
  h.receipts.set('0xhash0', receipt('0x1', 400_000n, [treasuryLog(10n ** 16n)]));
  await h.sender.onBlock(501);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('ПЛЮС') && lines[0]!.includes('+$19.20') && lines[0]!.includes('валидатор'));
  const rows = (await readFile(join(h.dir, 'results.csv'), 'utf8')).trim().split('\n');
  assert.ok(rows[0]!.startsWith('time,hash'));
  assert.ok(rows[1]!.includes(',won,19.2000,'));

  await h.sender.propose([sent({ decidedAtBlock: 501 })], context);
  await h.run();
  h.receipts.set('0xhash1', receipt('0x0', 55_000n));
  await h.sender.onBlock(502);
  assert.ok(lines[1]!.includes('МИНУС'));
  assert.equal((await readFile(join(h.dir, 'results.csv'), 'utf8')).trim().split('\n').length, 3, 'one header, one row each');
  await h.done();
});

test('every result is saved at once, so a crash cannot forget a loss', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  h.receipts.set('0xhash0', receipt('0x0', 55_000n));
  await h.sender.onBlock(501);
  const saved = JSON.parse(await readFile(h.stateFile, 'utf8')) as { dayNetUsd: number };
  assert.ok(saved.dayNetUsd < 0);
  assert.equal(h.sender.summary.stoppedEarly, 1);
  await h.done();
});

test('a costly failure quarantines the pools it went through', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  h.receipts.set('0xhash0', receipt('0x0', 400_000n));
  await h.sender.onBlock(501);
  assert.ok((h.guard.state.quarantinedUntil[POOL_A] ?? 0) > NOW);
  await h.done();
});

test('an attempt that missed its block sends nothing more on its own', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.onBlock(501);
  await h.sender.onBlock(502);
  assert.equal(h.broadcasted.length, 1);
  await h.done();
});

test('the next trade takes over a missed attempt\'s nonce, paying enough for nodes to accept it', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.onBlock(501);
  await h.sender.propose([sent({ decidedAtBlock: 501 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 2, 'a missed block does not cost the blocks after it');
  const [first, second] = h.broadcasted.map((raw) => parseTransaction(raw as `0x${string}`));
  assert.equal(second!.nonce, first!.nonce);
  assert.ok(second!.maxPriorityFeePerGas! * 100n >= first!.maxPriorityFeePerGas! * 110n);
  assert.ok(second!.maxFeePerGas! * 100n >= first!.maxFeePerGas! * 110n);
  assert.equal(h.sender.summary.replaced, 1);
  await h.done();
});

test('whichever version lands is the one counted, and the next attempt uses the next nonce', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.propose([sent({ decidedAtBlock: 501 })], context);
  await h.run();
  h.receipts.set('0xhash0', receipt('0x1', 400_000n, [treasuryLog(10n ** 16n)]));
  await h.sender.onBlock(502);
  assert.equal(h.sender.summary.won, 1);

  // The node is a moment behind and still reports the old count.
  await h.sender.propose([sent({ decidedAtBlock: 502 })], context);
  await h.run();
  const nonces = h.broadcasted.map((raw) => parseTransaction(raw as `0x${string}`).nonce);
  assert.deepEqual(nonces, [7, 7, 8]);
  await h.done();
});

test('a replacement still waiting is dropped when the attempt before it lands first', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.propose([sent({ decidedAtBlock: 501 })], context);
  h.receipts.set('0xhash0', receipt('0x0', 55_000n));
  await h.sender.onBlock(502);
  await h.run();
  assert.equal(h.broadcasted.length, 1, 'its nonce is already spent');
  assert.equal(h.sender.summary.stoppedEarly, 1);
  await h.done();
});

test('a replacement that fails leaves the earlier attempt in charge of the nonce', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.propose([sent({ decidedAtBlock: 501 })], { ...context, timestamp: NOW / 1000 - 30 });
  await h.run();
  assert.equal(h.sender.summary.refused['too-late'], 1);
  h.receipts.set('0xhash0', receipt('0x0', 55_000n));
  await h.sender.onBlock(502);
  assert.equal(h.sender.summary.stoppedEarly, 1, 'it is still being watched');
  await h.done();
});

test('a node failing while preparing costs that attempt only, and never the block', async () => {
  const h = await harness();
  h.nodeDown.value = true;
  await h.sender.propose([sent()], context);
  assert.equal(h.sender.summary.refused['node-unavailable'], 1);
  h.nodeDown.value = false;
  await h.sender.propose([sent({ decidedAtBlock: 501 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  await h.done();
});

test('at the moment of sending it pays just above a pending rival when that is worth it', async () => {
  const h = await harness({ needTipWei: () => 2_000_000_000n });
  await h.sender.propose([sent({ profitUsd: 60 })], context);
  await h.run();
  const [tx] = h.broadcasted.map((raw) => parseTransaction(raw as `0x${string}`));
  assert.equal(tx!.maxPriorityFeePerGas, 2_000_000_000n);
  assert.ok((await readFile(h.logFile, 'utf8')).includes('"raised":true'));
  await h.done();
});

test('a trade a pending rival would close, and not worth beating, is never sent', async () => {
  const h = await harness({ needTipWei: () => 9_000_000_000n });
  await h.sender.propose([sent({ profitUsd: 2 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['not-worth-sending'], 1);
  await h.sender.propose([sent({ decidedAtBlock: 501, profitUsd: 2 })], context);
  assert.equal(h.sender.summary.refused['attempt-in-flight'], undefined, 'and it does not block what comes next');
  await h.done();
});

test('when the base fee jumps, a trade that would not cover its failures is not sent', async () => {
  const h = await harness({ needTipWei: () => 0n });
  // At 6 gwei a failure costs about 60 cents, so a win must leave well over ten dollars.
  await h.sender.propose([sent({ profitUsd: 8, gasUnits: 300_000n })], { ...context, nextBaseFeeWei: 6_000_000_000n });
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['not-worth-sending'], 1);

  await h.sender.propose([sent({ decidedAtBlock: 501, profitUsd: 40, gasUnits: 300_000n })], { ...context, nextBaseFeeWei: 6_000_000_000n });
  await h.run();
  assert.equal(h.broadcasted.length, 1, 'one worth it still goes, whatever the gas');
  await h.done();
});

test('the closed route is left out and the rest of the batch still goes', async () => {
  const h = await harness({ needTipWei: (trade) => (trade.profitUsd === 2 ? 9_000_000_000n : 0n) });
  await h.sender.propose([sent({ profitUsd: 2 }), sent({ profitUsd: 7 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  const log = await readFile(h.logFile, 'utf8');
  assert.ok(log.includes('"routes":1'));
  assert.ok(log.includes('"profitUsd":7'));
  await h.done();
});

test('a raise the limits refuse falls back to the routes that need none', async () => {
  const h = await harness({ limits: { maxAttemptFailureUsd: 0.2 }, needTipWei: (trade) => (trade.profitUsd === 900 ? 20_000_000_000n : 0n) });
  await h.sender.propose([sent({ profitUsd: 900 }), sent({ profitUsd: 7 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  const log = await readFile(h.logFile, 'utf8');
  assert.ok(log.includes('"routes":1') && log.includes('"profitUsd":7'), 'the closed route stays out, the open one goes');
  await h.done();
});

test('a place behind a pending transaction goes out at once, at exactly its tip, even below the usual minimum', async () => {
  const h = await harness({ needTipWei: () => 9_000_000_000n });
  await h.sender.propose([sent({ profitUsd: 20 })], context, { tipWei: 1000n });
  await h.run();
  const [tx] = h.broadcasted.map((raw) => parseTransaction(raw as `0x${string}`));
  assert.equal(tx!.maxPriorityFeePerGas, 1000n, 'nothing may move it out of its place');
  assert.ok((await readFile(h.logFile, 'utf8')).includes('"placed":true'));
  await h.done();
});

test('a place too near the block is refused, since it could not reach the proposer in time', async () => {
  const h = await harness();
  await h.sender.propose([sent({ profitUsd: 20 })], { ...context, timestamp: NOW / 1000 - 11 }, { tipWei: 1000n });
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['too-late-to-place'], 1);
  await h.done();
});

test('a place cannot replace an attempt when nodes would demand more than the place allows', async () => {
  const h = await harness();
  await h.sender.propose([sent()], context);
  await h.run();
  await h.sender.propose([sent({ decidedAtBlock: 501 })], context, { tipWei: 1000n });
  await h.run();
  assert.equal(h.broadcasted.length, 1);
  assert.equal(h.sender.summary.refused['no-room-to-replace'], 1);
  await h.done();
});

const nodeAnswering = (result: () => Promise<string>): Rpc => ({
  call: <T>() => result() as Promise<T>,
});

test('a node that hangs cannot hold a transaction up', async () => {
  const hanging = nodeAnswering(() => new Promise(() => {}));
  const quick = nodeAnswering(async () => '0xabc');
  const { accepted, answers } = broadcast([{ name: 'hanging', rpc: hanging }, { name: 'quick', rpc: quick }], '0x02', Date.now, 20);
  assert.equal(await accepted, '0xabc');
  const results = await answers;
  assert.deepEqual(results.map((a) => [a.name, a.ok]), [['hanging', false], ['quick', true]]);
  assert.equal(results[0]!.error, 'timed out');
});

test('it counts as sent when any node took it, and fails only when none did', async () => {
  const refusing = nodeAnswering(async () => {
    throw new Error('already known');
  });
  const quick = nodeAnswering(async () => '0xabc');
  assert.equal(await broadcast([{ name: 'a', rpc: refusing }, { name: 'b', rpc: quick }], '0x02').accepted, '0xabc');
  await assert.rejects(broadcast([{ name: 'a', rpc: refusing }], '0x02').accepted, /every node refused/);
});

test('an attempt woken too close to its block is dropped rather than sent to fail', async () => {
  const h = await harness();
  // Decided long enough ago that the moment has passed.
  await h.sender.propose([sent()], { ...context, timestamp: NOW / 1000 - 30 });
  await h.run();
  assert.equal(h.broadcasted.length, 0);
  assert.equal(h.sender.summary.refused['too-late'], 1);
  await h.sender.propose([sent({ decidedAtBlock: 600 })], context);
  await h.run();
  assert.equal(h.broadcasted.length, 1, 'it does not block the next attempt');
  await h.done();
});

test('a node refusing the transaction frees the sender and is logged', async () => {
  const h = await harness({ refuseBroadcast: true });
  await h.sender.propose([sent()], context);
  await h.run();
  assert.equal(h.sender.summary.sendErrors, 1);
  assert.ok((await readFile(h.logFile, 'utf8')).includes('send-error'));
  await h.done();
});
