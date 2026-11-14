import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Rpc } from '../src/rpc.ts';
import type { BlockHeader, ForeseenTrade, Prices, SentTrade } from '../src/paper/engine.ts';
import { Foresight, tipInNextBlock, type PendingCall } from '../src/paper/foresight.ts';
import { PoolBook, type PoolLog, type PoolMeta } from '../src/paper/pools.ts';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const POOL = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const E18 = 10n ** 18n;
const prices: Prices = { usd: new Map([[WETH, { price: 2000, decimals: 18 }]]), nativeUsd: 2000 };
const meta: PoolMeta = { address: POOL, kind: 'v2', token0: USDC, token1: WETH, fee: 3000, tickSpacing: 0 };
const metas = new Map([[POOL, meta]]);
const hex = (x: bigint): string => x.toString(16).padStart(64, '0');
const syncLog = (r0: bigint, r1: bigint, tx = '0xpending'): PoolLog => ({ address: POOL, topics: [SYNC], data: `0x${hex(r0)}${hex(r1)}`, transactionHash: tx, logIndex: '0x0' });
const header = (number: number): BlockHeader => ({ number, timestamp: 1000, baseFeeWei: 10n ** 9n, gasUsed: 0n, gasLimit: 1n, miner: '0xminer' });

test('a transaction that cannot pay the next base fee has no tip, and a tip is capped by what is left', () => {
  assert.equal(tipInNextBlock({ maxFeePerGas: '0x5', maxPriorityFeePerGas: '0x1' }, 10n), null);
  assert.equal(tipInNextBlock({ maxFeePerGas: '0xc', maxPriorityFeePerGas: '0x5' }, 10n), 2n, 'only 2 of the 5 fit under the cap');
  assert.equal(tipInNextBlock({ maxFeePerGas: '0x14', maxPriorityFeePerGas: '0x5' }, 10n), 5n);
  assert.equal(tipInNextBlock({ gasPrice: '0x14' }, 10n), 10n, 'an old-style transaction pays all above the base fee');
});

test('imagining a block leaves the real book exactly as it was', () => {
  const book = new PoolBook([meta]);
  book.apply(syncLog(1000n * E18, E18));
  const before = book.rate(POOL, true);
  const inside = book.whatIf([syncLog(2000n * E18, E18)], (changed) => {
    assert.ok(changed.has(POOL));
    return book.rate(POOL, true);
  });
  assert.notEqual(inside, before);
  assert.equal(book.rate(POOL, true), before);
  assert.equal(book.modelErrors.v2.length, 0, 'what has not happened is no evidence about the model');
});

test('it puts everything back even when the look throws, and a pool it never knew stays unknown', () => {
  const book = new PoolBook([meta]);
  assert.throws(() => book.whatIf([syncLog(E18, E18)], () => {
    throw new Error('boom');
  }));
  assert.equal(book.rate(POOL, true), null);
});

interface Scene {
  foresight: Foresight;
  file: string;
  settle: () => Promise<void>;
  entries: () => Promise<Record<string, unknown>[]>;
  calls: string[];
  done: () => Promise<void>;
  foreseeCalls: readonly PoolLog[][];
  /** A block in which the router touched our pool, so that its pending transactions get a look. */
  learn: () => Promise<void>;
  send: (hash?: string) => void;
}

const scene = async (options: { logs?: { address: string; topics: string[]; data: string }[]; found?: ForeseenTrade[]; tx?: Partial<PendingCall>; status?: string } = {}): Promise<Scene> => {
  const dir = await mkdtemp(join(tmpdir(), 'cryptome-foresight-'));
  const file = join(dir, 'log.jsonl');
  const calls: string[] = [];
  const foreseeCalls: PoolLog[][] = [];
  const rpc: Rpc = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === 'eth_getBlockByNumber') return { transactions: [{ hash: '0xearlier', to: '0xROUTER' }] } as T;
      if (method === 'eth_simulateV1') return [{ calls: [{ status: options.status ?? '0x1', gasUsed: '0x10', logs: options.logs ?? [syncLog(1000n * E18, E18)] }] }] as T;
      if (method === 'eth_call') return '0x60' as T;
      throw new Error(`unexpected ${method}`);
    },
  };
  const book = new PoolBook([meta]);
  const foresight = new Foresight({
    rpc,
    book,
    metas,
    wrappedNative: WETH,
    foresee: (logs) => {
      foreseeCalls.push([...logs]);
      return options.found ?? [];
    },
    tipOf: async () => 5,
    logFile: file,
    minNetUsd: 0.25,
    now: () => 1_000_000,
  });
  return {
    foresight,
    file,
    calls,
    foreseeCalls,
    settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    learn: () => foresight.onBlock(header(1), [syncLog(E18, E18, '0xearlier')], 'builder', 10n ** 9n, prices),
    send: (hash = '0xpending') => foresight.onPending({ hash, from: '0xa', to: '0xrouter', input: '0x1234', value: '0x0', gas: '0x1', blockNumber: null, maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...options.tx }),
    entries: async () => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    done: () => rm(dir, { recursive: true, maxRetries: 5 }),
  };
};

const opened: ForeseenTrade = { route: [WETH, USDC], pools: [POOL, POOL], amountIn: E18, pricesAtDecision: [1n, 1n], startGap: 10n ** 16n, profitUsd: 7, usdPerUnit: 2000 / 1e18 };

test('a contract never seen touching our pools costs the node nothing', async () => {
  const s = await scene();
  await s.foresight.onBlock(header(1), [], 'builder', 10n ** 9n, prices);
  s.send();
  await s.settle();
  assert.equal(s.calls.length, 0);
  assert.equal(s.foresight.stats.pending, 1);
  await s.done();
});

test('a pending transaction is looked at once, and only one touching our pools reaches the search', async () => {
  const s = await scene();
  await s.learn();
  s.send();
  s.send();
  await s.settle();
  assert.equal(s.calls.filter((m) => m === 'eth_simulateV1').length, 1);
  assert.equal(s.foreseeCalls.length, 1);

  const elsewhere = await scene({ logs: [{ ...syncLog(E18, E18), address: OTHER }] });
  await elsewhere.learn();
  elsewhere.send('0xa');
  await elsewhere.settle();
  assert.equal(elsewhere.foreseeCalls.length, 0);
  await s.done();
  await elsewhere.done();
});

test('a transaction reported as pending after its block is not looked at again', async () => {
  const s = await scene();
  await s.learn();
  await s.foresight.onBlock(header(2), [syncLog(E18, E18, '0xmined')], 'builder', 10n ** 9n, prices);
  s.send('0xmined');
  await s.settle();
  assert.equal(s.calls.filter((m) => m === 'eth_simulateV1').length, 0, 'its swap is already in the state');
  s.send('0xpending');
  await s.settle();
  assert.equal(s.calls.filter((m) => m === 'eth_simulateV1').length, 1, 'a truly pending one still is');
  await s.done();
});

test('it looks at nothing while its book is far behind the chain', async () => {
  const s = await scene();
  await s.foresight.onBlock({ ...header(1), timestamp: 900 }, [syncLog(E18, E18, '0xearlier')], 'builder', 10n ** 9n, prices);
  s.send();
  await s.settle();
  assert.equal(s.calls.filter((m) => m === 'eth_simulateV1').length, 0);
  await s.done();
});

test('it ignores what cannot matter: plain transfers, too cheap, or failing', async () => {
  for (const options of [{ tx: { input: '0x' } }, { tx: { to: null } }, { tx: { maxFeePerGas: '0x1' } }, { status: '0x0' }]) {
    const s = await scene(options);
    await s.learn();
    s.send();
    await s.settle();
    assert.equal(s.foreseeCalls.length, 0, JSON.stringify(options));
    await s.done();
  }
});

test('a foreseen gap is logged with the tip it must stay under, and compared with the block that follows', async () => {
  const s = await scene({ found: [opened] });
  await s.learn();
  s.send();
  await s.settle();
  const [seen] = await s.entries();
  assert.equal(seen!.event, 'foreseen');
  assert.equal(seen!.modelUsd, 7);
  assert.equal(seen!.tipWei, '1000000000');
  assert.equal(seen!.msBeforeNextBlock, 1000 * 1000 + 12_000 - 1_000_000);
  assert.equal(seen!.proofError, 'no result', 'it says why a gap could not be proven');

  await s.foresight.onBlock(header(2), [syncLog(E18, E18, '0xearlier'), syncLog(E18, E18, '0xpending'), syncLog(E18, E18, '0xrival')], 'validator', 10n ** 9n, prices);
  await s.settle();
  const landed = (await s.entries()).find((entry) => entry.event === 'landed')!;
  assert.equal(landed.block, 2);
  assert.equal(landed.kind, 'validator');
  assert.equal(landed.touchedBefore, 1);
  assert.deepEqual(landed.nextTouchers, [{ hash: '0xrival', tip: 5 }]);
  await s.done();
});

test('a proven gap with room behind its opener is handed on with the tip for that place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cryptome-foresight-'));
  const profitWord = hex(10n ** 16n);
  const returned = `0x${profitWord}${hex(128n)}${hex(300_000n)}${hex(0n)}${hex(0n)}`;
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'eth_getBlockByNumber') return { transactions: [{ hash: '0xearlier', to: '0xrouter' }] } as T;
      if (method === 'eth_call') return '0x60' as T;
      const calls = (params[0] as { blockStateCalls: { calls: unknown[] }[] }).blockStateCalls[0]!.calls;
      return [{ calls: calls.length === 1 ? [{ status: '0x1', logs: [syncLog(1000n * E18, E18)] }] : [{ status: '0x1', logs: [] }, { status: '0x1', gasUsed: '0x493e0', returnData: returned }] }] as T;
    },
  };
  const handed: { tipWei: bigint; gasUnits: bigint; profitUsd: number }[] = [];
  const foresight = new Foresight({
    rpc,
    book: new PoolBook([meta]),
    metas,
    wrappedNative: WETH,
    foresee: () => [{ ...opened, pools: [POOL], route: [USDC, WETH] }],
    tipOf: async () => 5,
    logFile: join(dir, 'log.jsonl'),
    minNetUsd: 0.25,
    onBackrun: (trade, tipWei) => handed.push({ tipWei, gasUnits: trade.gasUnits, profitUsd: trade.profitUsd }),
    now: () => 1_000_000,
  });
  await foresight.onBlock(header(1), [syncLog(E18, E18, '0xearlier')], 'builder', 10n ** 8n, prices);
  await new Promise((resolve) => setTimeout(resolve, 20));
  foresight.onPending({ hash: '0xpending', from: '0xa', to: '0xrouter', input: '0x1234', value: '0x0', gas: '0x1', blockNumber: null, maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(handed.length, 1);
  assert.ok(handed[0]!.tipWei < 1_000_000_000n, 'below the opener');
  assert.equal(handed[0]!.gasUnits, 360_000n, 'what the proof measured, plus what a transaction costs around it');
  assert.ok(Math.abs(handed[0]!.profitUsd - 20) < 1e-9);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('the tip to beat is the highest pending rival that would leave too little of the route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cryptome-foresight-'));
  const book = new PoolBook([meta]);
  book.apply(syncLog(1000n * E18, E18));
  const edgeNow = book.rate(POOL, true)!;
  let logs = [syncLog(2000n * E18, E18)];
  const rpc: Rpc = {
    async call<T>(method: string): Promise<T> {
      if (method === 'eth_getBlockByNumber') return { transactions: [{ hash: '0xearlier', to: '0xrouter' }] } as T;
      return [{ calls: [{ status: '0x1', logs }] }] as T;
    },
  };
  const foresight = new Foresight({ rpc, book, metas, wrappedNative: WETH, foresee: () => [], tipOf: async () => 5, logFile: join(dir, 'log.jsonl'), minNetUsd: 0.25, now: () => 1_000_000 });
  await foresight.onBlock(header(1), [syncLog(1000n * E18, E18, '0xearlier')], 'builder', 10n ** 8n, prices);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pending = (hash: string, tip: bigint): PendingCall => ({ hash, from: '0xa', to: '0xrouter', input: '0x12', value: '0x0', gas: '0x1', blockNumber: null, maxFeePerGas: `0x${(tip + 10n ** 9n).toString(16)}`, maxPriorityFeePerGas: `0x${tip.toString(16)}` });
  const trade: SentTrade = { decidedAtBlock: 1, route: [USDC, WETH], pools: [POOL], amountIn: E18, pricesAtDecision: [1n], startGap: BigInt(Math.floor((edgeNow - 1) * 1e18)), profitUsd: 10, bidUsd: 0, gasUnits: 300_000n, usdPerUnit: 1 };
  assert.equal(foresight.needTipWei(trade, 1), 0n, 'nothing pending, nothing to beat');
  // It moves the route's only price so that selling token0 pays far less.
  logs = [syncLog(10_000n * E18, E18)];
  foresight.onPending(pending('0xrival', 700n));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(foresight.needTipWei({ ...trade, startGap: 10n ** 16n, route: [USDC, WETH] }, 1), 701n);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a real trade is logged with the rivals visible when it was decided', async () => {
  const s = await scene();
  await s.learn();
  s.send();
  await s.settle();
  const trade: SentTrade = { decidedAtBlock: 1, route: [WETH, USDC], pools: [POOL], amountIn: E18, pricesAtDecision: [1n], startGap: 1n, profitUsd: 3, bidUsd: 0.1, gasUnits: 300_000n, usdPerUnit: 1 };
  s.foresight.noteTrades([trade]);
  await s.settle();
  const entry = (await s.entries()).find((e) => e.event === 'trade-rivals')! as { rivals: { hash: string; tipWei: string }[] };
  assert.equal(entry.rivals.length, 1);
  assert.equal(entry.rivals[0]!.hash, '0xpending');
  assert.equal(entry.rivals[0]!.tipWei, '1000000000');
  await s.done();
});
