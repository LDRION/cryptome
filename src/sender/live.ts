import { existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { keccak256, type PrivateKeyAccount } from 'viem';
import { encodeRunBatch, hopsOf } from '../executor.ts';
import type { SentTrade } from '../paper/engine.ts';
import type { PoolMeta } from '../paper/pools.ts';
import type { Rpc } from '../rpc.ts';
import { broadcast, type BroadcastNode, type NodeAnswer } from './broadcast.ts';
import type { BundleCheck } from './bundle-check.ts';
import { bundleBidShare } from './bundles.ts';
import { chooseTip, planBatch, SEND_LEAD_MS, type BatchPlan } from './plan.ts';
import { resultCsv, resultLine, RESULTS_HEADER, type ResultRow } from './results.ts';
import type { AttemptResult, RiskGuard } from './risk.ts';

/**
 * Sends real transactions with real money. One nonce is out at a time, so a run of failures cannot
 * pile up unseen. It only ever pays from the sender's own balance, which is the most it can lose,
 * and profit goes to the treasury fixed in the contract.
 *
 * An attempt that missed its block is left out: if it lands it only reverts on the block check,
 * for about the price of a cancellation. The next trade takes over its nonce, so a missed block
 * never costs the blocks after it, where the same dislocation often pays again.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Below this a failed attempt stopped at its price checks. Above it the model was wrong. */
const COSTLY_FAILURE_GAS = 100_000n;
const COSTLY_FAILURE_GAS_PER_ROUTE = 30_000n;
/** Nodes reject a replacement paying less than 10% more than what it replaces. */
const SECONDS_PER_SLOT = 12;
const REPLACEMENT_FEE_BUMP_PERCENT = 115n;
const largest = (a: bigint, b: bigint): bigint => (a > b ? a : b);
/** Sending closer than this to the block is pointless, since it would not reach the proposer. */
const TOO_LATE_MARGIN_MS = 500;
const PLACE_MARGIN_MS = 1500;

export const REQUIRED_CONFIRMATION = 'I_ACCEPT_REAL_LOSSES';

interface Receipt {
  status: string;
  blockNumber?: string;
  gasUsed: string;
  effectiveGasPrice: string;
  logs: { address: string; topics: string[]; data: string }[];
}

/** What a mined attempt means for the limits. Exported because this decides the stop rule. */
export function classifyReceipt(receipt: Receipt, attempt: { treasury: string; usdPerUnit: ReadonlyMap<string, number>; routes: number }, nativeUsd: number): AttemptResult {
  const paidWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const costUsd = (Number(paidWei) / 1e18) * nativeUsd;
  if (receipt.status !== '0x1') {
    const costly = COSTLY_FAILURE_GAS + COSTLY_FAILURE_GAS_PER_ROUTE * BigInt(attempt.routes - 1);
    return BigInt(receipt.gasUsed) > costly ? { kind: 'costly-failure', costUsd, pools: [] } : { kind: 'stopped-early', costUsd };
  }
  let grossUsd = 0;
  for (const log of receipt.logs) {
    const usdPerUnit = attempt.usdPerUnit.get(log.address.toLowerCase());
    if (usdPerUnit !== undefined && log.topics[0] === TRANSFER_TOPIC && `0x${log.topics[2]?.slice(-40)}`.toLowerCase() === attempt.treasury) grossUsd += Number(BigInt(log.data)) * usdPerUnit;
  }
  return { kind: 'won', netUsd: grossUsd - costUsd };
}

export interface LiveSenderOptions {
  /** Must not retry: "not mined yet" looks like an error to a retrying client, and the wait would hold up every block. */
  rpc: Rpc;
  /** Nodes that pass transactions on to the public mempool. Private ones would never reach a self-built block. */
  broadcast: BroadcastNode[];
  account: PrivateKeyAccount;
  executor: `0x${string}`;
  treasury: string;
  chainId: number;
  metas: ReadonlyMap<string, PoolMeta>;
  wrappedNative: string;
  guard: RiskGuard;
  stateFile: string;
  logFile: string;
  /** Creating this file stops all sending immediately. */
  stopFile: string;
  /** Gas money that must remain, so that a stuck attempt can always be replaced. */
  reserveWei: bigint;
  /** The tip that goes ahead of whatever is pending and would close this route, if that is known. */
  needTipWei?: (trade: SentTrade, neededUsd: number) => bigint;
  /** Where each finished attempt is written, and who built a given block, if known. */
  resultsFile?: string;
  blockKindOf?: (block: number) => string | null;
  /** The failures to expect per win in the block at this timestamp, when its odds are known. */
  failuresPerWin?: (blockTimestamp: number) => number;
  /** Whether a public attempt is worth it in the block at this timestamp; elsewhere only bundles go. */
  slotTakesPublic?: (blockTimestamp: number) => boolean;
  /** Hands a signed transaction to builders privately. It costs nothing unless it lands. */
  sendBundle?: (txs: readonly `0x${string}`[], targetBlock: number) => Promise<NodeAnswer[]>;
  /** Whether a bundle works at the top of its block, where no rival can be ahead of it. */
  checkBundle?: (txs: readonly `0x${string}`[], targetBlock: number) => Promise<BundleCheck>;
  /** Asks a builder, once the block has passed, what it did with the bundle. Null if there is no one to ask. */
  traceBundle?: (answers: NodeAnswer[], targetBlock: number) => Promise<Record<string, unknown> | null>;
  /** Where the line about a finished attempt goes. The console, unless told otherwise. */
  say?: (line: string) => void;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
}

interface Version {
  plan: BatchPlan;
  /** Every trade the plan carries, in the plan's order. */
  trades: SentTrade[];
  nativeUsd: number;
  context: ProposeContext;
  /** Its tip was chosen for one exact place in the block, so nothing may change it on the way out. */
  placed: boolean;
  /** Set when the usual bid did not fit the limits or the balance. */
  atMostTipWei?: bigint;
}

interface SentVersion extends Version {
  hash: `0x${string}`;
  raised: boolean;
}

interface InFlight {
  nonce: number;
  /** Everything signed for this nonce so far. Any of them can be the one that lands. */
  sent: SentVersion[];
  /** The next version, waiting for its moment to go out. */
  queued: Version | null;
}

export interface ProposeContext {
  nextBaseFeeWei: bigint;
  nativeUsd: number;
  timestamp: number;
  minNetUsd: number;
  failureGasUnits: bigint;
}

export class LiveSender {
  private readonly options: LiveSenderOptions;
  private inFlight: InFlight | null = null;
  private nextNonce = 0;
  /** Bundles whose block has not passed yet. They hold no nonce, as they cost nothing unless they land. */
  private bundles: (SentVersion & { nonce: number })[] = [];
  readonly summary = { sent: 0, won: 0, stoppedEarly: 0, costly: 0, replaced: 0, netUsd: 0, refused: {} as Record<string, number>, sendErrors: 0, bundles: 0, bundlesLanded: 0 };

  constructor(options: LiveSenderOptions) {
    this.options = options;
  }

  private log(entry: Record<string, unknown>): Promise<void> {
    return appendFile(this.options.logFile, `${JSON.stringify(entry)}\n`);
  }

  private refuse(reason: string, trades: readonly SentTrade[] = []): void {
    this.summary.refused[reason] = (this.summary.refused[reason] ?? 0) + 1;
    // What was not sent, what it was worth, and why, is as much a part of the record as what was.
    const worth = trades.length > 0 ? { targetBlock: trades[0]!.decidedAtBlock + 1, routes: trades.length, profitUsd: trades.reduce((total, trade) => total + trade.profitUsd, 0) } : {};
    void this.log({ event: 'refused', reason, at: (this.options.now ?? Date.now)(), ...worth }).catch(() => {});
  }

  private async record(result: AttemptResult): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    this.options.guard.record(result, now);
    // Saved before anything else happens, so a crash cannot forget a loss.
    await writeFile(this.options.stateFile, JSON.stringify(this.options.guard.state, null, 2));
  }

  /** Takes everything this block offers that pays for itself, if nothing is out already. */
  async propose(trades: SentTrade[], context: ProposeContext, placing?: { tipWei: bigint }): Promise<void> {
    if (trades.length === 0) return;
    const { guard, stopFile, account, rpc, reserveWei } = this.options;
    const now = (this.options.now ?? Date.now)();
    if (existsSync(stopFile)) return this.refuse('stop-file');

    const out = this.inFlight;
    const latest = out?.sent.at(-1)?.plan;
    const decidedBlock = trades[0]!.decidedAtBlock;
    // Only an attempt whose block has passed gives up its nonce.
    if (out && (out.queued || !latest || latest.targetBlock > decidedBlock)) return this.refuse('attempt-in-flight', trades);

    const usable = trades.filter((trade) => !guard.inQuarantine(trade.pools, now));
    if (usable.length === 0) return this.refuse('pool-in-quarantine', trades);
    // Builder blocks took 63 public attempts and gave no win, and trades from $20 never won at all, so
    // whatever the size, outside a nearly sure slot a trade goes only where a failure costs nothing.
    if (this.options.slotTakesPublic && !this.options.slotTakesPublic(context.timestamp + SECONDS_PER_SLOT)) {
      if (!this.options.sendBundle) return this.refuse('unlikely-slot', usable);
      // A place behind a pending transaction goes its own way, with that transaction in the bundle.
      return placing ? undefined : this.proposeBundle(usable, context);
    }
    // Taking a place needs time for the transaction to spread and reach the proposer.
    if (placing && now > (context.timestamp + 12) * 1000 - PLACE_MARGIN_MS) return this.refuse('too-late-to-place', usable);
    const atLeastTipWei = latest ? (latest.tipWeiPerGas * REPLACEMENT_FEE_BUMP_PERCENT) / 100n : 0n;
    // Replacing what is out takes more than it paid, which may no longer fit behind the opener.
    if (placing && atLeastTipWei > placing.tipWei) return this.refuse('no-room-to-replace', usable);
    const planFor = (maxRoutes?: number, atMostTipWei?: bigint): BatchPlan | null =>
      this.planOf(usable, context, latest, { ...(maxRoutes ? { maxRoutes } : {}), ...(placing ? { exactTipWei: placing.tipWei } : {}), ...(atMostTipWei !== undefined ? { atMostTipWei } : {}) });
    let plan = planFor();
    if (!plan) return this.refuse('no-plan', usable);

    let attempt = out;
    let atMostTipWei: bigint | undefined;
    try {
      const balance = BigInt(await rpc.call<string>('eth_getBalance', [account.address, 'latest']));
      const maxFailureUsd = guard.limits.maxAttemptFailureUsd;
      const fits = (candidate: BatchPlan): boolean => balance >= candidate.gasLimit * candidate.maxFeePerGas + reserveWei && candidate.failureCostUsd <= maxFailureUsd;
      // A large trade bids a lot. When that much does not fit, the bid gives way and not the trade.
      const affordable = (maxRoutes?: number): BatchPlan | null => {
        const wanted = planFor(maxRoutes);
        if (!wanted || fits(wanted)) return wanted;
        const byBalance = (balance - reserveWei) / wanted.gasLimit;
        const byLimit = BigInt(Math.floor(Number(wanted.maxFeePerGas) * (maxFailureUsd / wanted.failureCostUsd) * 0.99));
        const fee = byBalance < byLimit ? byBalance : byLimit;
        if (fee <= context.nextBaseFeeWei) return null;
        const lowered = planFor(maxRoutes, fee - context.nextBaseFeeWei);
        if (!lowered || !fits(lowered)) return null;
        atMostTipWei = lowered.tipWeiPerGas;
        return lowered;
      };
      // One route may still fit when a whole batch does not.
      plan = affordable() ?? affordable(1) ?? plan;
      if (balance < plan.gasLimit * plan.maxFeePerGas + reserveWei) return this.refuse('balance-too-low', usable);
      if (!attempt) {
        const mined = Number(BigInt(await rpc.call<string>('eth_getTransactionCount', [account.address, 'latest'])));
        // A node a moment behind must not make the next attempt reuse a nonce already spent.
        attempt = { nonce: Math.max(mined, this.nextNonce), sent: [], queued: null };
      }
    } catch {
      // A hiccup costs this attempt only. The block itself must go on being processed.
      return this.refuse('node-unavailable', usable);
    }

    const chosen = plan.routes.map((route) => usable[route.index]!);
    const verdict = guard.check({ pools: chosen.flatMap((trade) => trade.pools), failureCostUsd: plan.failureCostUsd }, now);
    if (!verdict.ok) return this.refuse(verdict.reason, chosen);

    const version: Version = { plan, trades: chosen, nativeUsd: context.nativeUsd, context, placed: placing !== undefined, ...(atMostTipWei !== undefined ? { atMostTipWei } : {}) };
    attempt.queued = version;
    this.inFlight = attempt;
    // A place behind a pending transaction is worth more the sooner it is taken.
    const delay = placing ? 0 : Math.max(plan.sendAtMs - now, 0);
    const schedule = this.options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    const taken = attempt;
    schedule(() => void this.send(taken, version), delay);
  }

  /**
   * Offers what public sending would risk gas on to the builders instead. If someone else takes the gap
   * the bundle is thrown away for free, so it needs no room for failures, only a bid that can win.
   */
  private async proposeBundle(trades: SentTrade[], context: ProposeContext, opener?: `0x${string}`): Promise<void> {
    const { guard, account, rpc, reserveWei } = this.options;
    const now = (this.options.now ?? Date.now)();
    if (now > (context.timestamp + SECONDS_PER_SLOT) * 1000 - TOO_LATE_MARGIN_MS) return this.refuse('too-late', trades);
    const bidShare = bundleBidShare(trades[0]!.decidedAtBlock + 1);
    const offered = trades.map((trade) => ({ ...trade, bidUsd: trade.profitUsd * bidShare }));
    let plan = this.planOf(offered, context, undefined);
    if (!plan) return this.refuse('no-plan', trades);
    let nonce: number;
    try {
      const balance = BigInt(await rpc.call<string>('eth_getBalance', [account.address, 'latest']));
      if (balance < plan.gasLimit * plan.maxFeePerGas + reserveWei) {
        const fee = (balance - reserveWei) / plan.gasLimit;
        plan = fee > context.nextBaseFeeWei ? this.planOf(offered, context, undefined, { atMostTipWei: fee - context.nextBaseFeeWei }) : null;
        if (!plan || balance < plan.gasLimit * plan.maxFeePerGas + reserveWei) return this.refuse('balance-too-low', trades);
      }
      nonce = Math.max(Number(BigInt(await rpc.call<string>('eth_getTransactionCount', [account.address, 'latest']))), this.nextNonce);
    } catch {
      return this.refuse('node-unavailable', trades);
    }
    const chosen = plan.routes.map((route) => offered[route.index]!);
    const verdict = guard.check({ pools: chosen.flatMap((trade) => trade.pools), failureCostUsd: 0 }, now);
    if (!verdict.ok) return this.refuse(verdict.reason, chosen);
    try {
      const signed = await this.sign(plan, chosen, nonce);
      const hash = keccak256(signed);
      this.bundles.push({ plan, trades: chosen, nativeUsd: context.nativeUsd, context, placed: false, hash, raised: false, nonce });
      this.summary.bundles++;
      const profitUsd = chosen.reduce((total, trade) => total + trade.profitUsd, 0);
      const bidUsd = chosen.reduce((total, trade) => total + trade.bidUsd, 0);
      await this.log({ event: 'bundle', hash, nonce, targetBlock: plan.targetBlock, routes: chosen.length, profitUsd, bidShare, bidUsd, behind: opener ? keccak256(opener) : null, tipWeiPerGas: plan.tipWeiPerGas.toString(), maxFeePerGas: plan.maxFeePerGas.toString(), gasLimit: plan.gasLimit.toString(), at: now });
      const txs = opener ? [opener, signed] : [signed];
      void this.options
        .sendBundle!(txs, plan.targetBlock)
        .then(async (builders) => {
          await this.log({ event: 'bundle-answers', hash, builders });
          if (!this.options.traceBundle) return;
          const trace = await this.options.traceBundle(builders, plan.targetBlock).catch((err: Error) => ({ error: err.message.slice(0, 160) }));
          if (trace) await this.log({ event: 'bundle-trace', hash, ...trace });
        })
        .catch(() => {});
      // A check that could not run says nothing about the bundle, so it is kept apart from a failed one.
      if (this.options.checkBundle) void this.options.checkBundle(txs, plan.targetBlock).then((check) => this.log({ event: 'bundle-check', hash, ...check }), (err: Error) => this.log({ event: 'bundle-check', hash, error: err.message.slice(0, 160) })).catch(() => {});
    } catch (err) {
      this.summary.sendErrors++;
      await this.log({ event: 'send-error', message: (err as Error).message.slice(0, 200) });
    }
  }

  /**
   * Goes right behind a pending transaction, by putting that transaction first in the bundle. Its sender
   * loses nothing: it runs as it would have, and ours runs after it or the bundle is thrown away.
   */
  async proposeBackrunBundle(trades: SentTrade[], context: ProposeContext, opener: `0x${string}`): Promise<void> {
    if (!this.options.sendBundle || trades.length === 0) return;
    const now = (this.options.now ?? Date.now)();
    if (existsSync(this.options.stopFile)) return this.refuse('stop-file');
    const usable = trades.filter((trade) => !this.options.guard.inQuarantine(trade.pools, now));
    if (usable.length === 0) return this.refuse('pool-in-quarantine', trades);
    await this.proposeBundle(usable, context, opener);
  }

  private sign(plan: BatchPlan, trades: readonly SentTrade[], nonce: number): Promise<`0x${string}`> {
    const { account, executor, chainId, metas, wrappedNative } = this.options;
    const routes = trades.map((trade, i) => ({
      start: trade.route[0]!,
      amountIn: trade.amountIn,
      hops: hopsOf(trade.route, trade.pools, metas, wrappedNative, trade.pricesAtDecision),
      minProfit: plan.routes[i]!.minProfitUnits,
      startGap: trade.startGap,
      minGap: plan.routes[i]!.minGap,
      gasLimit: plan.routes[i]!.gasLimit,
    }));
    return account.signTransaction({ chainId, type: 'eip1559', to: executor, data: encodeRunBatch(routes, BigInt(plan.targetBlock)), value: 0n, nonce, gas: plan.gasLimit, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.tipWeiPerGas });
  }

  private planOf(trades: readonly SentTrade[], context: ProposeContext, latest: BatchPlan | undefined, extra: { maxRoutes?: number; exactTipWei?: bigint; atLeastTipWei?: bigint; atMostTipWei?: bigint } = {}): BatchPlan | null {
    const bump = (wei: bigint): bigint => (wei * REPLACEMENT_FEE_BUMP_PERCENT) / 100n;
    return planBatch({
      trades: trades.map((trade) => ({ profitUsd: trade.profitUsd, bidUsd: trade.bidUsd, usdPerStartUnit: trade.usdPerUnit, gasUnits: trade.gasUnits, startGap: trade.startGap })),
      nextBaseFeeWei: context.nextBaseFeeWei,
      nativeUsd: context.nativeUsd,
      decidedBlockTimestamp: context.timestamp,
      decidedBlock: trades[0]!.decidedAtBlock,
      failureGasUnits: context.failureGasUnits,
      minNetUsd: context.minNetUsd,
      ...extra,
      ...(latest ? { atLeastMaxFeeWei: bump(latest.maxFeePerGas) } : {}),
      ...(latest || extra.atLeastTipWei ? { atLeastTipWei: largest(latest ? bump(latest.tipWeiPerGas) : 0n, extra.atLeastTipWei ?? 0n) } : {}),
    });
  }

  /**
   * The last look before sending, when the most of the mempool is visible. Goes just ahead of the
   * pending transactions that would close a route if that pays, and leaves out what would only burn gas.
   */
  private withOpenBook(version: Version, latest: BatchPlan | undefined): Version | null {
    const { needTipWei, guard } = this.options;
    if (!needTipWei || version.placed) return version;
    const { plan, trades, context } = version;
    const cap = version.atMostTipWei !== undefined ? { atMostTipWei: version.atMostTipWei } : {};
    const usdOfGas = (gas: bigint): number => (Number(gas * (context.nextBaseFeeWei + plan.tipWeiPerGas)) / 1e18) * context.nativeUsd;
    const needs = trades.map((trade) => needTipWei(trade, usdOfGas(trade.gasUnits) + context.minNetUsd));
    const failuresPerWin = this.options.failuresPerWin?.(context.timestamp + SECONDS_PER_SLOT);
    const choice = chooseTip({
      trades: trades.map((trade, i) => ({ profitUsd: trade.profitUsd, gasUnits: trade.gasUnits, needTipWei: needs[i]! })),
      baseTipWei: plan.tipWeiPerGas,
      nextBaseFeeWei: context.nextBaseFeeWei,
      nativeUsd: context.nativeUsd,
      minNetUsd: context.minNetUsd,
      ...(failuresPerWin !== undefined ? { failuresPerWin } : {}),
    });
    if (!choice) return null;
    if (choice.tipWei === plan.tipWeiPerGas && choice.keep.length === trades.length) return version;
    const kept = choice.keep.map((i) => trades[i]!);
    const raised = this.planOf(kept, context, latest, { atLeastTipWei: choice.tipWei, ...cap });
    if (!raised) return null;
    const chosen = raised.routes.map((route) => kept[route.index]!);
    const verdict = guard.check({ pools: chosen.flatMap((trade) => trade.pools), failureCostUsd: raised.failureCostUsd }, (this.options.now ?? Date.now)());
    if (verdict.ok) return { ...version, plan: raised, trades: chosen };

    // The limits refuse the higher tip, so only what needs no raise can still go.
    const unblocked = trades.filter((_, i) => needs[i]! <= plan.tipWeiPerGas);
    if (unblocked.length === 0) return null;
    const lower = this.planOf(unblocked, context, latest, cap);
    return lower ? { ...version, plan: lower, trades: lower.routes.map((route) => unblocked[route.index]!) } : null;
  }

  /** Gives up on the version waiting to go out. Whatever is already out stays in charge of the nonce. */
  private drop(attempt: InFlight): void {
    attempt.queued = null;
    if (attempt.sent.length === 0) this.inFlight = null;
  }

  private async send(attempt: InFlight, queued: Version): Promise<void> {
    const { stopFile } = this.options;
    // Something sent earlier landed while this waited, so its nonce is already spent.
    if (this.inFlight !== attempt) return;
    // The file may have appeared while waiting for the moment to send.
    if (existsSync(stopFile)) {
      this.drop(attempt);
      return this.refuse('stop-file');
    }
    // Waking up late, it could only land after its block and burn gas on the block check.
    if ((this.options.now ?? Date.now)() > queued.plan.sendAtMs + SEND_LEAD_MS - TOO_LATE_MARGIN_MS) {
      this.drop(attempt);
      return this.refuse('too-late', queued.trades);
    }
    const version = this.withOpenBook(queued, attempt.sent.at(-1)?.plan);
    if (!version) {
      this.drop(attempt);
      return this.refuse('not-worth-sending', queued.trades);
    }
    const { plan, trades } = version;
    try {
      const signed = await this.sign(plan, trades, attempt.nonce);
      const { accepted, answers } = broadcast(this.options.broadcast, signed, this.options.now);
      const hash = await accepted;
      const replacing = attempt.sent.at(-1)?.hash ?? null;
      attempt.sent.push({ ...version, hash, raised: plan.tipWeiPerGas !== queued.plan.tipWeiPerGas });
      attempt.queued = null;
      this.summary.sent++;
      if (replacing) this.summary.replaced++;
      const profitUsd = trades.reduce((total, trade) => total + trade.profitUsd, 0);
      await this.log({ event: 'sent', hash, nonce: attempt.nonce, replacing, targetBlock: plan.targetBlock, routes: trades.length, profitUsd, placed: version.placed, failuresPerWin: this.options.failuresPerWin?.(version.context.timestamp + SECONDS_PER_SLOT), raised: plan.tipWeiPerGas !== queued.plan.tipWeiPerGas, tipWeiPerGas: plan.tipWeiPerGas.toString(), gasLimit: plan.gasLimit.toString(), failureCostUsd: plan.failureCostUsd, at: (this.options.now ?? Date.now)() });
      // Which entrances took it is what tells a transaction that spread from one that did not.
      void answers.then((nodes) => this.log({ event: 'broadcast', hash, nodes })).catch(() => {});
    } catch (err) {
      this.summary.sendErrors++;
      this.drop(attempt);
      await this.log({ event: 'send-error', message: (err as Error).message.slice(0, 200) });
    }
  }

  /** Checks for whatever was sent once its block has passed. Called for every new block. */
  async onBlock(number: number): Promise<void> {
    await this.checkBundles(number);
    const attempt = this.inFlight;
    const first = attempt?.sent[0];
    if (!attempt || !first || number < first.plan.targetBlock) return;

    // The newest is the likeliest to have landed.
    for (const version of [...attempt.sent].reverse()) {
      const receipt = await this.options.rpc.call<Receipt>('eth_getTransactionReceipt', [version.hash]).catch(() => null);
      if (!receipt) continue;
      await this.settle(version, receipt, number, attempt.nonce);
      return;
    }
  }

  /** A bundle can land only in its own block, and a node may be one block behind in saying so. */
  private async checkBundles(number: number): Promise<void> {
    for (const bundle of [...this.bundles]) {
      if (number < bundle.plan.targetBlock) continue;
      const receipt = await this.options.rpc.call<Receipt>('eth_getTransactionReceipt', [bundle.hash]).catch(() => null);
      if (receipt) {
        this.summary.bundlesLanded++;
        this.bundles = this.bundles.filter((other) => other !== bundle);
        const profitUsd = bundle.trades.reduce((total, trade) => total + trade.profitUsd, 0);
        await this.log({ event: 'sent', hash: bundle.hash, nonce: bundle.nonce, targetBlock: bundle.plan.targetBlock, routes: bundle.trades.length, profitUsd, bundle: true, tipWeiPerGas: bundle.plan.tipWeiPerGas.toString(), gasLimit: bundle.plan.gasLimit.toString(), at: (this.options.now ?? Date.now)() });
        await this.settle(bundle, receipt, number, bundle.nonce);
      } else if (number > bundle.plan.targetBlock) {
        this.bundles = this.bundles.filter((other) => other !== bundle);
      }
    }
  }

  private async settle(version: SentVersion, receipt: Receipt, number: number, nonce: number): Promise<void> {
    const usdPerUnit = new Map(version.trades.map((trade) => [trade.route[0]!, trade.usdPerUnit]));
    const result = classifyReceipt(receipt, { treasury: this.options.treasury, usdPerUnit, routes: version.trades.length }, version.nativeUsd);
    const outcome = result.kind === 'costly-failure' ? { ...result, pools: version.trades.flatMap((trade) => trade.pools) } : result;
    if (outcome.kind === 'won') {
      this.summary.won++;
      this.summary.netUsd += outcome.netUsd;
    } else if (outcome.kind === 'stopped-early') {
      this.summary.stoppedEarly++;
      this.summary.netUsd -= outcome.costUsd;
    } else if (outcome.kind === 'costly-failure') {
      this.summary.costly++;
      this.summary.netUsd -= outcome.costUsd;
    }
    this.nextNonce = Math.max(this.nextNonce, nonce + 1);
    // Whatever else was waiting on this nonce can no longer land.
    if (this.inFlight && this.inFlight.nonce <= nonce) this.inFlight = null;
    await this.record(outcome);
    await this.log({ event: 'settled', hash: version.hash, block: number, targetBlock: version.plan.targetBlock, minedBlock: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null, tipWeiPerGas: version.plan.tipWeiPerGas.toString(), status: receipt.status, gasUsed: receipt.gasUsed, ...outcome });
    await this.showResult(version, receipt, outcome);
  }

  /** Says plainly what the attempt came to. A problem here must never touch the sending itself. */
  private async showResult(version: SentVersion, receipt: Receipt, outcome: AttemptResult): Promise<void> {
    try {
      const { resultsFile, blockKindOf, say, guard } = this.options;
      const row: ResultRow = {
        at: (this.options.now ?? Date.now)(),
        hash: version.hash,
        targetBlock: version.plan.targetBlock,
        minedBlock: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
        blockKind: blockKindOf?.(version.plan.targetBlock) ?? null,
        result: outcome.kind,
        netUsd: outcome.kind === 'won' ? outcome.netUsd : outcome.kind === 'not-included' ? 0 : -outcome.costUsd,
        expectedUsd: version.trades.reduce((total, trade) => total + trade.profitUsd, 0),
        routes: version.trades.length,
        placed: version.placed,
        raised: version.raised,
        tipGwei: Number(version.plan.tipWeiPerGas) / 1e9,
        baseFeeGwei: Number(version.context.nextBaseFeeWei) / 1e9,
        gasUsed: Number(BigInt(receipt.gasUsed)),
        totalNetUsd: guard.state.totalNetUsd,
      };
      (say ?? console.log)(resultLine(row, this.summary.netUsd));
      if (resultsFile) {
        if (!existsSync(resultsFile)) await writeFile(resultsFile, `${RESULTS_HEADER}\n`);
        await appendFile(resultsFile, `${resultCsv(row)}\n`);
      }
    } catch {
      // Only the display failed. The result itself is already saved.
    }
  }
}
