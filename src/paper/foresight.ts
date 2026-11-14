import { appendFile } from 'node:fs/promises';
import { decodeRunProfit, encodeRun, EXECUTOR, executorCode, hopsOf, SIMULATED_OWNER } from '../executor.ts';
import type { Rpc } from '../rpc.ts';
import { rawOfPending } from '../sender/bundles.ts';
import { backrunTip } from '../sender/plan.ts';
import { TX_OVERHEAD_GAS } from './chain-view.ts';
import type { BlockHeader, ForeseenTrade, Prices, SentTrade } from './engine.ts';
import { poolKeyOf, type PoolBook, type PoolLog, type PoolMeta } from './pools.ts';

/**
 * Sees a block before it exists. A block ordered by tip is an open book: every bid is in the
 * public mempool and the order follows from them. So each pending transaction is run in a real
 * EVM on the latest state, to learn what it would do to our pools and what gap it would open.
 *
 * This only reads and writes a log. It sends nothing, so its worth can be measured against the
 * blocks that really follow before any money depends on it.
 */

const CONCURRENCY = 2;
/** Falling behind the stream means looking at transactions too late to matter. */
const MAX_QUEUE = 40;
const KEEP_PENDING_MS = 60_000;
const KEEP_SEEN = 50_000;
/** A contract that has not touched our pools for about a day is no longer worth a simulation. */
const KNOWN_FOR_BLOCKS = 7200;
const MAX_PROOFS_PER_TX = 2;
/** A book this far behind the chain would show gaps that closed long ago. */
const MAX_BOOK_AGE_MS = 20_000;

export interface PendingCall {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gas: string;
  blockNumber: string | null;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

interface SimulatedCall {
  status: string;
  gasUsed?: string;
  returnData?: string;
  logs?: { address: string; topics: string[]; data: string }[];
  error?: { message?: string; data?: string };
}

interface Touching {
  hash: string;
  tipWei: bigint;
  seenMs: number;
  logs: PoolLog[];
  pools: Set<string>;
  foreseen: boolean;
}

export interface ForesightOptions {
  rpc: Rpc;
  book: PoolBook;
  metas: ReadonlyMap<string, PoolMeta>;
  wrappedNative: string;
  foresee: (logs: readonly PoolLog[], nextFeeWei: bigint, prices: Prices) => ForeseenTrade[];
  tipOf: (block: number, hash: string) => Promise<number>;
  logFile: string;
  minNetUsd: number;
  /** The failures to expect per win in the block at this timestamp, when its odds are known. */
  failuresPerWin?: (blockTimestamp: number) => number;
  /** Called with a trade proven to pay right behind a pending transaction, and the tip that puts it there. */
  onBackrun?: (trade: SentTrade, tipWei: bigint, state: { nextFeeWei: bigint; prices: Prices; timestamp: number }) => void;
  /** Called with a trade proven to pay behind a pending transaction, and that transaction's exact bytes. */
  onPrivateBackrun?: (trade: SentTrade, opener: `0x${string}`, state: { nextFeeWei: bigint; prices: Prices; timestamp: number }) => void;
  now?: () => number;
}

const callOf = (tx: PendingCall): Record<string, string> => ({ from: tx.from, to: tx.to!, data: tx.input, value: tx.value, gas: tx.gas });

/** What a transaction would pay per gas in the next block, or null if it could not be included. */
export function tipInNextBlock(tx: Pick<PendingCall, 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice'>, nextFeeWei: bigint): bigint | null {
  const cap = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? '0x0');
  if (cap < nextFeeWei) return null;
  const room = cap - nextFeeWei;
  const wanted = tx.maxPriorityFeePerGas === undefined ? room : BigInt(tx.maxPriorityFeePerGas);
  return wanted < room ? wanted : room;
}

export class Foresight {
  private readonly options: ForesightOptions;
  private readonly seen = new Set<string>();
  private readonly queue: PendingCall[] = [];
  /** Contracts recently seen touching our pools. Almost nothing else can, so this spares the node. */
  private readonly known = new Map<string, number>();
  private readonly touching = new Map<string, Touching>();
  private readonly foreseen = new Map<string, ForeseenTrade[]>();
  private running = 0;
  private latest: { number: number; nextFeeWei: bigint; prices: Prices; blockMs: number } | null = null;
  readonly stats = { pending: 0, knownContracts: 0, toKnown: 0, dropped: 0, simulated: 0, touchedPools: 0, foreseen: 0, proved: 0, placed: 0, errors: 0 };

  constructor(options: ForesightOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(entry: Record<string, unknown>): void {
    void appendFile(this.options.logFile, `${JSON.stringify(entry, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}\n`).catch(() => {});
  }

  onPending(tx: PendingCall): void {
    if (this.seen.has(tx.hash)) return;
    this.seen.add(tx.hash);
    if (this.seen.size > KEEP_SEEN) this.seen.delete(this.seen.values().next().value!);
    this.stats.pending++;
    if (!tx.to || tx.input === '0x' || !this.known.has(tx.to.toLowerCase())) return;
    this.stats.toKnown++;
    if (this.queue.length >= MAX_QUEUE) {
      this.stats.dropped++;
      return;
    }
    this.queue.push(tx);
    this.pump();
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const tx = this.queue.shift()!;
      this.running++;
      void this.look(tx)
        .catch(() => {
          this.stats.errors++;
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private async look(tx: PendingCall): Promise<void> {
    const { hash } = tx;
    const state = this.latest;
    const seenMs = this.now();
    if (!state || seenMs - state.blockMs > MAX_BOOK_AGE_MS) return;
    const tipWei = tipInNextBlock(tx, state.nextFeeWei);
    if (tipWei === null) return;

    const [simulated] = await this.simulate([callOf(tx)]);
    this.stats.simulated++;
    if (simulated?.status !== '0x1') return;
    const logs: PoolLog[] = (simulated.logs ?? []).map((log, i) => ({ address: log.address, topics: log.topics, data: log.data, transactionHash: hash, logIndex: `0x${i.toString(16)}` }));
    const ours = logs.filter((log) => this.options.metas.has(poolKeyOf(log)));
    if (ours.length === 0) return;

    this.stats.touchedPools++;
    const pools = new Set(ours.map((log) => poolKeyOf(log)));
    const entry: Touching = { hash, tipWei, seenMs, logs: ours, pools, foreseen: false };
    this.touching.set(hash, entry);

    const found = this.options.foresee(ours, state.nextFeeWei, state.prices);
    if (found.length === 0) return;
    entry.foreseen = true;
    this.stats.foreseen += found.length;
    this.foreseen.set(hash, found);
    const proofs = await Promise.all(found.slice(0, MAX_PROOFS_PER_TX).map((trade) => this.prove(tx, trade)));
    for (const [i, trade] of found.entries()) {
      const proof = proofs[i];
      let plannedTipWei: bigint | null = null;
      if (proof && 'provenUsd' in proof) {
        const gasUnits = BigInt(proof.gasUsed) + TX_OVERHEAD_GAS;
        const rivalTipWei = this.rivalBelow(tipWei, hash, trade.pools);
        const handed: SentTrade = { decidedAtBlock: state.number, route: trade.route, pools: trade.pools, amountIn: trade.amountIn, pricesAtDecision: trade.pricesAtDecision, startGap: trade.startGap, profitUsd: proof.provenUsd, bidUsd: 0, gasUnits, usdPerUnit: trade.usdPerUnit };
        const handedState = { nextFeeWei: state.nextFeeWei, prices: state.prices, timestamp: state.blockMs / 1000 };
        const opener = this.options.onPrivateBackrun ? rawOfPending(tx as unknown as Record<string, unknown>) : null;
        if (opener) this.options.onPrivateBackrun?.(handed, opener, handedState);
        plannedTipWei = backrunTip({ profitUsd: proof.provenUsd, gasUnits, openerTipWei: tipWei, rivalTipWei, nextBaseFeeWei: state.nextFeeWei, nativeUsd: state.prices.nativeUsd, minNetUsd: this.options.minNetUsd, ...(this.options.failuresPerWin ? { failuresPerWin: this.options.failuresPerWin(state.blockMs / 1000 + 12) } : {}) });
        if (plannedTipWei !== null) {
          this.stats.placed++;
          this.options.onBackrun?.(handed, plannedTipWei, handedState);
        }
      }
      this.log({
        plannedTipWei,
        event: 'foreseen',
        hash,
        at: seenMs,
        msBeforeNextBlock: state.blockMs + 12_000 - seenMs,
        afterBlock: state.number,
        tipWei,
        route: trade.route,
        pools: trade.pools,
        amountIn: trade.amountIn,
        modelUsd: trade.profitUsd,
        ...(proofs[i] ?? {}),
      });
    }
  }

  /** The most any other pending transaction on these pools pays below this tip. */
  private rivalBelow(tipWei: bigint, hash: string, pools: readonly string[]): bigint {
    let highest = 0n;
    for (const entry of this.touching.values()) {
      if (entry.hash !== hash && entry.tipWei <= tipWei && entry.tipWei > highest && pools.some((pool) => entry.pools.has(pool))) highest = entry.tipWei;
    }
    return highest;
  }

  /**
   * The tip that goes ahead of every pending transaction that would leave too little of this route.
   * Those paying most go first in such a block, so each is judged with the ones above it applied.
   */
  needTipWei(trade: SentTrade, neededUsd: number): bigint {
    const floor = 1 + (Number(trade.startGap) / 1e18) * Math.sqrt(Math.min(neededUsd / trade.profitUsd, 1));
    const rivals = [...this.touching.values()].filter((entry) => trade.pools.some((pool) => entry.pools.has(pool))).sort((a, b) => (a.tipWei > b.tipWei ? -1 : 1));
    const logs: PoolLog[] = [];
    for (const rival of rivals) {
      logs.push(...rival.logs);
      const edge = this.routeEdge(trade, logs);
      if (edge === null || edge < floor) return rival.tipWei + 1n;
    }
    return 0n;
  }

  private async simulate(calls: Record<string, string>[], stateOverrides?: Record<string, unknown>): Promise<SimulatedCall[]> {
    const result = await this.options.rpc.call<{ calls: SimulatedCall[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ calls, ...(stateOverrides ? { stateOverrides } : {}) }], validation: false }, 'latest']);
    return result[0]?.calls ?? [];
  }

  /** Runs the transaction and then our trade in a real EVM, in the order the block would. */
  private async prove(tx: PendingCall, trade: ForeseenTrade): Promise<{ provenUsd: number; gasUsed: number } | { proofError: string }> {
    try {
      const hops = hopsOf(trade.route, trade.pools, this.options.metas, this.options.wrappedNative, trade.pricesAtDecision);
      const data = encodeRun(trade.route[0]!, trade.amountIn, hops, 0n, 0n, { startGap: trade.startGap, minGap: 0n });
      const code = await executorCode(this.options.rpc);
      const calls = await this.simulate([callOf(tx), { from: SIMULATED_OWNER, to: EXECUTOR, data, gas: '0x1c9c380' }], { [EXECUTOR]: { code } });
      const [theirs, ours] = calls;
      if (theirs?.status !== '0x1') return { proofError: 'their transaction failed' };
      if (ours?.status !== '0x1' || !ours.returnData) return { proofError: ours?.error?.data ?? ours?.error?.message ?? 'no result' };
      this.stats.proved++;
      return { provenUsd: Number(decodeRunProfit(ours.returnData as `0x${string}`)) * trade.usdPerUnit, gasUsed: Number(BigInt(ours.gasUsed ?? '0x0')) };
    } catch (err) {
      return { proofError: (err as Error).message.slice(0, 120) };
    }
  }

  /** Records what was known about a real trade's rivals when it was decided. */
  noteTrades(trades: readonly SentTrade[]): void {
    if (trades.length === 0) return;
    const now = this.now();
    for (const trade of trades) {
      const rivals = [...this.touching.values()].filter((entry) => trade.pools.some((pool) => entry.pools.has(pool))).sort((a, b) => (a.tipWei > b.tipWei ? -1 : 1));
      const edgeAfter = rivals.map((rival) => this.routeEdge(trade, rival.logs));
      this.log({ event: 'trade-rivals', decidedAtBlock: trade.decidedAtBlock, pools: trade.pools, profitUsd: trade.profitUsd, at: now, rivals: rivals.map((rival, i) => ({ hash: rival.hash, tipWei: rival.tipWei, seenAgoMs: now - rival.seenMs, edgeAfter: edgeAfter[i] })) });
    }
  }

  private routeEdge(trade: SentTrade, logs: readonly PoolLog[]): number | null {
    const { book, metas } = this.options;
    return book.whatIf(logs, () => {
      let product = 1;
      for (const [i, pool] of trade.pools.entries()) {
        const meta = metas.get(pool);
        const rate = meta ? book.rate(pool, meta.token0 === trade.route[i]) : null;
        if (rate === null) return null;
        product *= rate;
      }
      return product;
    });
  }

  /** Remembers which contracts this block's transactions called to reach our pools. */
  private async learn(block: number, poolsOf: ReadonlyMap<string, unknown>): Promise<void> {
    if (poolsOf.size === 0) return;
    const full = await this.options.rpc.call<{ transactions: { hash: string; to: string | null }[] }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, true]);
    for (const tx of full.transactions) {
      if (tx.to && poolsOf.has(tx.hash)) this.known.set(tx.to.toLowerCase(), block);
    }
    for (const [contract, last] of this.known) if (block - last > KNOWN_FOR_BLOCKS) this.known.delete(contract);
    this.stats.knownContracts = this.known.size;
  }

  /** Compares what was foreseen with what the block really did, then starts on the next one. */
  async onBlock(header: BlockHeader, logs: readonly PoolLog[], kind: string, nextFeeWei: bigint, prices: Prices): Promise<void> {
    this.latest = { number: header.number, nextFeeWei, prices, blockMs: header.timestamp * 1000 };
    const order: string[] = [];
    const poolsOf = new Map<string, Set<string>>();
    for (const log of logs) {
      if (!poolsOf.has(log.transactionHash)) {
        poolsOf.set(log.transactionHash, new Set());
        order.push(log.transactionHash);
      }
      poolsOf.get(log.transactionHash)!.add(poolKeyOf(log));
    }
    // The stream sometimes reports a transaction as pending seconds after it was mined. Simulated again on
    // a state that already holds it, its swap would count twice and draw a gap that is not there: 3 real
    // attempts went behind such openers and lost $0.50. Once in a block, it counts as seen.
    for (const hash of order) this.seen.add(hash);
    await this.learn(header.number, poolsOf).catch(() => {
      this.stats.errors++;
    });

    for (const hash of order) {
      const found = this.foreseen.get(hash);
      const entry = this.touching.get(hash);
      if (found && entry) {
        for (const trade of found) {
          const position = order.indexOf(hash);
          const touchesRoute = (tx: string): boolean => trade.pools.some((pool) => poolsOf.get(tx)?.has(pool));
          const before = order.slice(0, position).filter(touchesRoute);
          const after = order.slice(position + 1).filter(touchesRoute).slice(0, 3);
          const tipsAfter = await Promise.all(after.map((tx) => this.options.tipOf(header.number, tx).catch(() => Number.POSITIVE_INFINITY)));
          this.log({ event: 'landed', hash, block: header.number, kind, miner: header.miner, seenBeforeBlockMs: header.timestamp * 1000 - entry.seenMs, tipWei: entry.tipWei, modelUsd: trade.profitUsd, pools: trade.pools, touchedBefore: before.length, nextTouchers: after.map((tx, i) => ({ hash: tx, tip: tipsAfter[i] })) });
        }
      }
      this.touching.delete(hash);
      this.foreseen.delete(hash);
    }

    const oldest = this.now() - KEEP_PENDING_MS;
    for (const [hash, entry] of this.touching) {
      if (entry.seenMs >= oldest) continue;
      this.touching.delete(hash);
      this.foreseen.delete(hash);
    }
  }
}
