import { nextBaseFee } from '../amm.ts';
import { decide, type FailureMode, type GatePolicy, type RefusalReason } from '../gate.ts';
import { PoolBook, type PoolLog, type PoolMeta } from './pools.ts';
import { bestTrade, buildCycles, cycleProfit, marginalReturn, type Cycle } from './search.ts';

export interface BlockHeader {
  number: number;
  hash?: string;
  extraData?: string;
  timestamp: number;
  baseFeeWei: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  miner: string;
}

export interface Prices {
  /** USD per whole token, for each priced start token. */
  usd: Map<string, { price: number; decimals: number }>;
  nativeUsd: number;
}

export type Scenario = 'optimistic' | 'realistic' | 'brutal';
export type Outcome = 'won' | 'lost-to-rival' | 'not-included' | 'guard-reverted' | 'too-slow';
export const SCENARIOS: Scenario[] = ['optimistic', 'realistic', 'brutal'];

export interface EngineConfig {
  policy: GatePolicy;
  /** Share of profit after gas offered to the builder. */
  bidShare: number;
  /** Builders the bundle is sent to. An empty set means every builder. */
  builders: ReadonlySet<string>;
  baseGasUnits: bigint;
  gasUnitsPerHop: bigint;
  mode: FailureMode;
  startBalanceUsd: number;
  /** Time left to reach a builder. Latency above this misses the block. */
  deadlineMs: number;
  /** Assumed slowdown in the brutal world. */
  brutalLatencyFactor: number;
  /** Live mode: time spent checking a trade counts toward its latency. */
  countWorkTime?: boolean;
  /** Skips measuring gaps inside blocks, which takes most of the compute and earns nothing itself. */
  skipMidBlock?: boolean;
  /** Trades only for blocks this accepts. Others are not looked at. */
  targetsBlock?: (block: number) => boolean;
  /** Measures gaps inside only the blocks this accepts, so a sweep can afford to measure them. */
  scansInside?: (block: number) => boolean;
  /**
   * What decides who goes first between conflicting transactions. Builders rank by total
   * payment, while a validator building its own block ranks by the tip per unit of gas.
   */
  auction?: 'total-payment' | 'tip-per-gas';
  /**
   * For a public transaction, which pays by tip everywhere: true for blocks whose builder
   * ranks by total payment. Other blocks go by the tip per gas.
   */
  rankedByTotal?: (block: number) => boolean;
  /** Gas a failed attempt burns, when the contract checks the pools before it swaps. */
  failureGasUnits?: bigint;
}

/** Largest real payment by the transactions that closed a trade. Infinity when unknown. */
export type RivalLookup = (block: number, txHashes: string[], prices: Prices) => Promise<number>;

/** Highest tip per gas among the transactions that closed a trade. Infinity when unknown. */
export type TipLookup = (block: number, txHashes: string[]) => Promise<number>;

export type Proof = { ok: true; profit: bigint; gasUnits: bigint } | { ok: false; reason: string };

/** What only the chain itself can answer. Neither call may throw: failing means refusing. */
export interface ChainView {
  /** Updates what logs do not show and returns the pools that changed. */
  refresh(header: BlockHeader, book: PoolBook): Promise<string[]>;
  /** Executes a trade in a real EVM on this block's final state. */
  prove(block: number, cycle: Cycle, amountIn: bigint, pricesAtDecision: bigint[], startGap: bigint): Promise<Proof>;
}

export interface ScenarioResult {
  outcome: Outcome;
  netUsd: number;
}

/** A trade decided on the block just processed, with what a real sender would need. */
export interface SentTrade {
  decidedAtBlock: number;
  route: string[];
  pools: string[];
  amountIn: bigint;
  pricesAtDecision: bigint[];
  /** The route's gap when decided, as a fraction of 1e18. */
  startGap: bigint;
  profitUsd: number;
  bidUsd: number;
  gasUnits: bigint;
  usdPerUnit: number;
}

/** A gap that a pending transaction would open if it landed. */
export interface ForeseenTrade {
  route: string[];
  pools: string[];
  amountIn: bigint;
  pricesAtDecision: bigint[];
  startGap: bigint;
  profitUsd: number;
  usdPerUnit: number;
}

export interface OurTurn {
  /** Marginal return of the route when decided and at our turn. Above 1 means a gap. */
  startEdge: number;
  edge: number;
  /** Profit at our turn with the amount chosen in advance, in dollars. */
  fixedUsd: number;
  /** Profit at our turn with the amount the contract would scale to the gap that is left. */
  resizedUsd: number;
}

export interface SettledTrade {
  decidedAtBlock: number;
  targetBlock: number;
  route: string[];
  pools: string[];
  amountIn: string;
  profitUsd: number;
  /** What the model expected, kept to compare against the executed result. */
  modelProfitUsd: number;
  gasUnits: string;
  worstProfitUsd: number;
  gasUsd: number;
  bidUsd: number;
  rivalPaymentUsd: number;
  touchedByTxs: number;
  closedByTxs: string[];
  /** In a block ordered by tip: the route as it stands when our turn comes, after everyone paying more. */
  atOurTurn?: OurTurn;
  builder: string;
  latencyMs: number;
  results: Record<Scenario, ScenarioResult>;
}

interface Pending {
  cycle: Cycle;
  amountIn: bigint;
  /** Each hop's price when decided, which the contract compares with the price at its turn. */
  pricesAtDecision: bigint[];
  startGap: bigint;
  profitUsd: number;
  modelProfitUsd: number;
  worstProfit: bigint;
  gasUnits: bigint;
  gasUsd: number;
  bidUsd: number;
  latencyMs: number;
  decidedAtBlock: number;
  usdPerUnit: number;
  touchedBy: Set<string>;
  /** Transactions after which this trade could no longer cover its gas and bid. */
  closedBy: Set<string>;
  startEdge: number;
  /** The route after each transaction that touched it, in block order. */
  path: Map<string, RouteNow>;
}

export interface GapContribution {
  txHash: string;
  /** How much this transaction widened the gap. */
  usd: number;
}

export interface MidBlockGap {
  /** Transactions that opened and widened the gap. Their amounts add up to its size. */
  contributions: GapContribution[];
  route: string[];
  pools: string[];
  /** Profit after gas, before any builder payment. */
  usd: number;
  closedSameBlock: boolean;
}

export interface ScenarioStats {
  balanceUsd: number;
  outcomes: Record<Outcome, number>;
  netUsd: number;
  losingTrades: number;
  bestUsd: number;
  worstUsd: number;
}

export interface PaperStats {
  blocks: number;
  logs: number;
  dislocations: number;
  refusals: Partial<Record<RefusalReason, number>>;
  sent: number;
  scenarios: Record<Scenario, ScenarioStats>;
  midBlock: { routes: number; netOfGasUsd: number; closedSameBlock: number };
  /** How trades fared when executed in a real EVM before sending. */
  evm: { proved: number; rejected: number; modelUsd: number; evmUsd: number };
}

const newScenarioStats = (balanceUsd: number): ScenarioStats => ({
  balanceUsd,
  outcomes: { won: 0, 'lost-to-rival': 0, 'not-included': 0, 'guard-reverted': 0, 'too-slow': 0 },
  netUsd: 0,
  losingTrades: 0,
  bestUsd: 0,
  worstUsd: 0,
});

const MARGINAL_FLOOR = 1;
/** Checked best first, so a block full of false gaps cannot delay the real ones for long. */
const MAX_PROOFS_PER_BLOCK = 16;
/** A gap that widened is taken with a larger amount, up to this many times the planned one. */
const MAX_RESIZE = 2;

/** The best amount grows about in line with the gap, so a gap half as wide takes half the amount. */
export const gapScale = (edge: number, startEdge: number): number => (edge > 1 && startEdge > 1 ? Math.min((edge - 1) / (startEdge - 1), MAX_RESIZE) : 0);

interface RouteNow {
  edge: number;
  fixedUsd: number;
  resizedUsd: number;
}

export class PaperEngine {
  readonly book: PoolBook;
  readonly cycles: Cycle[];
  readonly stats: PaperStats;
  /** Gaps that opened inside the block just processed. */
  lastGaps: MidBlockGap[] = [];
  /** Trades decided on the block just processed, aimed at the next one. */
  lastSent: SentTrade[] = [];
  private openRoutes: ReadonlySet<string> = new Set();
  private readonly cyclesByPool = new Map<string, Cycle[]>();
  private readonly config: EngineConfig;
  private readonly lookup: RivalLookup;
  private readonly vetted: ReadonlySet<string>;
  private readonly view: ChainView | undefined;
  private readonly tipLookup: TipLookup | undefined;
  private pending: Pending[] = [];

  constructor(metas: PoolMeta[], starts: ReadonlySet<string>, allowed: ReadonlySet<string>, config: EngineConfig, lookup: RivalLookup, view?: ChainView, tipLookup?: TipLookup) {
    this.book = new PoolBook(metas);
    this.cycles = buildCycles(metas, starts, allowed);
    this.vetted = allowed;
    this.config = config;
    this.lookup = lookup;
    this.view = view;
    this.tipLookup = tipLookup;
    for (const cycle of this.cycles) {
      for (const hop of cycle.hops) {
        const routes = this.cyclesByPool.get(hop.pool);
        if (routes) routes.push(cycle);
        else this.cyclesByPool.set(hop.pool, [cycle]);
      }
    }
    this.stats = {
      blocks: 0,
      logs: 0,
      dislocations: 0,
      refusals: {},
      sent: 0,
      scenarios: {
        optimistic: newScenarioStats(config.startBalanceUsd),
        realistic: newScenarioStats(config.startBalanceUsd),
        brutal: newScenarioStats(config.startBalanceUsd),
      },
      midBlock: { routes: 0, netOfGasUsd: 0, closedSameBlock: 0 },
      evm: { proved: 0, rejected: 0, modelUsd: 0, evmUsd: 0 },
    };
  }

  private estimatedGasUnits(cycle: Cycle): bigint {
    return this.config.baseGasUnits + this.config.gasUnitsPerHop * BigInt(cycle.hops.length);
  }

  private gasUsdOf(units: bigint, baseFeeWei: bigint, nativeUsd: number): number {
    return (Number(units * baseFeeWei) / 1e18) * nativeUsd;
  }

  private gasUsdFor(cycle: Cycle, baseFeeWei: bigint, nativeUsd: number): number {
    return this.gasUsdOf(this.estimatedGasUnits(cycle), baseFeeWei, nativeUsd);
  }

  private bidFor(profitUsd: number, gasUsd: number): number {
    return Math.max(profitUsd * (1 - this.config.policy.profitHaircut) - gasUsd, 0) * this.config.bidShare;
  }

  /** Tip per gas that pays the bid. Only meaningful where the tip is how the bid is paid. */
  private tipWeiPerGas(bidUsd: number, units: bigint, nativeUsd: number): number {
    return this.config.auction === 'tip-per-gas' ? ((bidUsd / nativeUsd) * 1e18) / Number(units) : 0;
  }

  /** A failed attempt still pays its tip on whatever gas it burned, so stopping early matters. */
  private failureUsd(units: bigint, bidUsd: number, baseFeeWei: bigint, nativeUsd: number): number {
    const burned = Number(this.config.failureGasUnits ?? units);
    return ((burned * (Number(baseFeeWei) + this.tipWeiPerGas(bidUsd, units, nativeUsd))) / 1e18) * nativeUsd;
  }

  private gate(profitUsd: number, gasUsd: number, bidUsd: number, failureGasUsd: number, latencyMs: number, routeVetted: boolean): ReturnType<typeof decide> {
    return decide(
      {
        simulatedProfitUsd: profitUsd,
        gasUsd,
        builderPaymentUsd: bidUsd,
        failureGasUsd,
        // Unknown until live data measures it, so the gate assumes a coin flip.
        winProbability: 0.5,
        stateAgeMs: latencyMs,
        routeVetted,
        mode: this.config.mode,
      },
      this.config.policy,
    );
  }

  /** Settles what was sent for this block, applies its logs, then decides for the next one. */
  async onBlock(header: BlockHeader, logs: PoolLog[], prices: Prices, latencyMs = 0): Promise<SettledTrade[]> {
    const startedAt = performance.now();
    this.lastSent = [];
    this.stats.blocks++;
    this.stats.logs += logs.length;

    const targeted = this.pending;
    this.pending = [];
    const midBlockRoutes = new Map<string, { cycle: Cycle; usd: number; contributions: GapContribution[] }>();
    const changed = new Set<string>();
    let pendingScan = new Set<string>();
    let currentTx: string | null = null;

    const scansHere = this.config.scansInside ? this.config.scansInside(header.number) : !this.config.skipMidBlock;
    const scanMidBlock = (): void => {
      if (!scansHere) return;
      for (const cycle of this.routesThrough(pendingScan)) {
        // An unverified pool can show a price gap that its real fee would erase.
        if (!cycle.hops.every((hop) => this.book.isVerified(hop.pool))) continue;
        const gasUsd = this.gasUsdFor(cycle, header.baseFeeWei, prices.nativeUsd);
        const usd = this.grossUsd(cycle, gasUsd, prices) - gasUsd;
        const known = midBlockRoutes.get(cycle.key);
        const before = known?.usd ?? 0;
        if (usd <= before) continue;
        // Each transaction owns only what it added: a small trade landing after a whale
        // widens the gap but did not open it, and seeing it early would reveal little.
        const contributions = [...(known?.contributions ?? []), { txHash: currentTx ?? '', usd: usd - before }];
        midBlockRoutes.set(cycle.key, { cycle, usd, contributions });
      }
      pendingScan = new Set();
    };

    for (const log of logs) {
      if (log.transactionHash !== currentTx) {
        if (currentTx !== null) scanMidBlock();
        currentTx = log.transactionHash;
      }
      const pool = this.book.apply(log);
      if (pool === null) continue;
      changed.add(pool);
      pendingScan.add(pool);
      for (const trade of targeted) {
        if (!trade.cycle.hops.some((hop) => hop.pool === pool)) continue;
        trade.touchedBy.add(log.transactionHash);
        trade.path.set(log.transactionHash, this.routeNow(trade));
        // Leaving the range the model can see is treated as no profit, not as a known loss.
        const profit = cycleProfit(this.book, trade.cycle, trade.amountIn) ?? -1n;
        if (profit < trade.worstProfit) trade.worstProfit = profit;
        if (Number(profit) * trade.usdPerUnit < trade.gasUsd + trade.bidUsd) trade.closedBy.add(log.transactionHash);
      }
    }

    const settled: SettledTrade[] = [];
    for (const trade of targeted) settled.push(await this.settle(trade, header, prices));

    if (this.view) for (const pool of await this.view.refresh(header, this.book)) changed.add(pool);
    const openRoutes = await this.decide(header, changed, prices, latencyMs, startedAt);
    this.openRoutes = openRoutes;
    this.recordMidBlock(midBlockRoutes, openRoutes);
    return settled;
  }

  /**
   * The gaps these pending logs would open, best first and with no pool used twice. Routes already
   * open are left out: the normal path takes those, and this transaction did not create them.
   */
  foresee(logs: readonly PoolLog[], nextFeeWei: bigint, prices: Prices): ForeseenTrade[] {
    return this.book.whatIf(logs, (changed) => {
      const found: ForeseenTrade[] = [];
      for (const cycle of this.routesThrough(changed)) {
        if (this.openRoutes.has(cycle.key)) continue;
        const edge = marginalReturn(this.book, cycle);
        if (edge === null || edge <= MARGINAL_FLOOR) continue;
        if (!cycle.hops.every((hop) => this.book.isVerified(hop.pool)) || !cycle.tokens.every((token) => this.vetted.has(token))) continue;
        const gasUsd = this.gasUsdFor(cycle, nextFeeWei, prices.nativeUsd);
        const trade = bestTrade(this.book, cycle, this.toUnits(gasUsd + this.config.policy.minNetUsd, cycle, prices));
        if (!trade) continue;
        const profitUsd = this.toUsd(trade.profit, cycle, prices);
        if (profitUsd < gasUsd + this.config.policy.minNetUsd) continue;
        found.push({
          route: cycle.tokens,
          pools: cycle.hops.map((hop) => hop.pool),
          amountIn: trade.amountIn,
          pricesAtDecision: cycle.hops.map((hop) => this.book.priceForContract(hop.pool, hop.zeroForOne)),
          startGap: BigInt(Math.floor((edge - 1) * 1e18)),
          profitUsd,
          usdPerUnit: profitUsd / Number(trade.profit),
        });
      }
      found.sort((a, b) => b.profitUsd - a.profitUsd);
      const taken = new Set<string>();
      return found.filter((trade) => {
        if (trade.pools.some((pool) => taken.has(pool))) return false;
        for (const pool of trade.pools) taken.add(pool);
        return true;
      });
    });
  }

  private routeNow(trade: Pending): RouteNow {
    const edge = marginalReturn(this.book, trade.cycle) ?? 0;
    const usdOf = (units: bigint): number => Number(units) * trade.usdPerUnit;
    const resized = (trade.amountIn * BigInt(Math.floor(gapScale(edge, trade.startEdge) * 1e6))) / 1_000_000n;
    return {
      edge,
      fixedUsd: usdOf(cycleProfit(this.book, trade.cycle, trade.amountIn) ?? -1n),
      resizedUsd: resized > 0n ? usdOf(cycleProfit(this.book, trade.cycle, resized) ?? 0n) : 0,
    };
  }

  /** In a block ordered by tip, those paying more are all ahead of us, and the rest come after. */
  private async ourTurn(trade: Pending, block: number, ourTip: number): Promise<OurTurn> {
    let last: RouteNow = { edge: trade.startEdge, fixedUsd: trade.profitUsd, resizedUsd: trade.profitUsd };
    for (const [tx, state] of trade.path) {
      const tip = await (this.tipLookup?.(block, [tx]) ?? Number.POSITIVE_INFINITY);
      if (tip >= ourTip) last = state;
    }
    return { startEdge: trade.startEdge, ...last };
  }

  /** What the contract does at our turn. It cannot run the search, so it judges by the width of the gap. */
  private resultAtTurn(trade: Pending, turn: OurTurn, gasUsd: number, stopped: ScenarioResult): ScenarioResult {
    const costs = gasUsd + trade.bidUsd;
    const needed = costs + this.config.policy.minNetUsd;
    const scale = gapScale(turn.edge, turn.startEdge);
    if (scale * scale * trade.profitUsd < needed) return stopped;
    // It went on to swap, so only the final check can stop it now, with all the gas burned.
    return turn.resizedUsd >= needed ? { outcome: 'won', netUsd: turn.resizedUsd - costs } : { outcome: 'guard-reverted', netUsd: -costs };
  }

  /** Builds pool state and model trust from history without trading on it. */
  warm(logs: PoolLog[]): void {
    for (const log of logs) this.book.apply(log);
  }

  private routesThrough(pools: ReadonlySet<string>): Cycle[] {
    const seen = new Map<string, Cycle>();
    for (const pool of pools) {
      for (const cycle of this.cyclesByPool.get(pool) ?? []) seen.set(cycle.key, cycle);
    }
    return [...seen.values()];
  }

  private grossUsd(cycle: Cycle, costUsd: number, prices: Prices): number {
    const edge = marginalReturn(this.book, cycle);
    if (edge === null || edge <= MARGINAL_FLOOR) return 0;
    const trade = bestTrade(this.book, cycle, this.toUnits(costUsd, cycle, prices));
    return trade ? this.toUsd(trade.profit, cycle, prices) : 0;
  }

  private toUsd(amount: bigint, cycle: Cycle, prices: Prices): number {
    const priced = prices.usd.get(cycle.start);
    return priced ? (Number(amount) / 10 ** priced.decimals) * priced.price : 0;
  }

  private toUnits(usd: number, cycle: Cycle, prices: Prices): bigint {
    const priced = prices.usd.get(cycle.start);
    return priced ? BigInt(Math.floor((usd / priced.price) * 10 ** priced.decimals)) : 0n;
  }

  private async decide(header: BlockHeader, changed: ReadonlySet<string>, prices: Prices, latencyMs: number, startedAt: number): Promise<Set<string>> {
    const nextFee = nextBaseFee(header.baseFeeWei, header.gasUsed, header.gasLimit);
    const open = new Set<string>();
    const candidates: Pending[] = [];
    if (this.config.targetsBlock && !this.config.targetsBlock(header.number + 1)) return open;

    for (const cycle of this.routesThrough(changed)) {
      const edge = marginalReturn(this.book, cycle);
      if (edge === null || edge <= MARGINAL_FLOOR) continue;
      const gasUsd = this.gasUsdFor(cycle, nextFee, prices.nativeUsd);
      const trade = bestTrade(this.book, cycle, this.toUnits(gasUsd + this.config.policy.minNetUsd, cycle, prices));
      if (!trade) continue;

      open.add(cycle.key);
      this.stats.dislocations++;
      const profitUsd = this.toUsd(trade.profit, cycle, prices);
      const bidUsd = this.bidFor(profitUsd, gasUsd);
      const verified = cycle.hops.every((hop) => this.book.isVerified(hop.pool)) && cycle.tokens.every((token) => this.vetted.has(token));

      const units = this.estimatedGasUnits(cycle);
      const decision = this.gate(profitUsd, gasUsd, bidUsd, this.failureUsd(units, bidUsd, nextFee, prices.nativeUsd), latencyMs, verified);
      if (!decision.send) {
        this.stats.refusals[decision.reason] = (this.stats.refusals[decision.reason] ?? 0) + 1;
        continue;
      }
      candidates.push({
        cycle,
        amountIn: trade.amountIn,
        pricesAtDecision: cycle.hops.map((hop) => this.book.priceForContract(hop.pool, hop.zeroForOne)),
        startGap: BigInt(Math.floor((edge - 1) * 1e18)),
        profitUsd,
        modelProfitUsd: profitUsd,
        worstProfit: trade.profit,
        gasUnits: units,
        gasUsd,
        bidUsd,
        latencyMs,
        decidedAtBlock: header.number,
        usdPerUnit: profitUsd / Number(trade.profit),
        touchedBy: new Set(),
        closedBy: new Set(),
        startEdge: edge,
        path: new Map(),
      });
    }

    // Routes sharing a pool compete for the same mispricing, so only the best one can pay.
    candidates.sort((a, b) => b.profitUsd - a.profitUsd);
    const proven = this.view ? await this.proveAll(candidates, header.number, nextFee, prices, startedAt) : candidates;

    const used = new Set<string>();
    for (const candidate of proven) {
      if (candidate.cycle.hops.some((hop) => used.has(hop.pool))) continue;
      for (const hop of candidate.cycle.hops) used.add(hop.pool);
      this.pending.push(candidate);
      this.stats.sent++;
      this.lastSent.push({
        decidedAtBlock: candidate.decidedAtBlock,
        route: candidate.cycle.tokens,
        pools: candidate.cycle.hops.map((hop) => hop.pool),
        amountIn: candidate.amountIn,
        pricesAtDecision: candidate.pricesAtDecision,
        startGap: candidate.startGap,
        profitUsd: candidate.profitUsd,
        bidUsd: candidate.bidUsd,
        gasUnits: candidate.gasUnits,
        usdPerUnit: candidate.usdPerUnit,
      });
    }
    return open;
  }

  /**
   * Only the best route over each set of pools can be sent, so only those are proved, all at
   * once to cost one round trip. A rejected route frees its pools for the next round.
   */
  private async proveAll(candidates: Pending[], block: number, nextFee: bigint, prices: Prices, startedAt: number): Promise<Pending[]> {
    const accepted: Pending[] = [];
    const taken = new Set<string>();
    let remaining = candidates;
    let proofsLeft = MAX_PROOFS_PER_BLOCK;

    while (proofsLeft > 0) {
      const claimed = new Set(taken);
      const round: Pending[] = [];
      const later: Pending[] = [];
      for (const candidate of remaining) {
        const pools = candidate.cycle.hops.map((hop) => hop.pool);
        if (pools.some((pool) => taken.has(pool))) continue;
        if (round.length >= proofsLeft || pools.some((pool) => claimed.has(pool))) {
          later.push(candidate);
          continue;
        }
        round.push(candidate);
        for (const pool of pools) claimed.add(pool);
      }
      if (round.length === 0) break;
      proofsLeft -= round.length;

      const proofs = await Promise.all(round.map((candidate) => this.view!.prove(block, candidate.cycle, candidate.amountIn, candidate.pricesAtDecision, candidate.startGap)));
      const workMs = this.config.countWorkTime ? performance.now() - startedAt : 0;
      round.forEach((candidate, i) => {
        candidate.latencyMs += workMs;
        if (!this.applyProof(candidate, proofs[i]!, nextFee, prices)) return;
        accepted.push(candidate);
        for (const hop of candidate.cycle.hops) taken.add(hop.pool);
      });
      remaining = later;
    }
    return accepted.sort((a, b) => b.profitUsd - a.profitUsd);
  }

  /** Replaces the model's numbers with what really executed, then applies the gate again. */
  private applyProof(candidate: Pending, proof: Proof, nextFee: bigint, prices: Prices): boolean {
    const { evm } = this.stats;
    if (!proof.ok) {
      evm.rejected++;
      return false;
    }
    const profitUsd = this.toUsd(proof.profit, candidate.cycle, prices);
    const gasUsd = this.gasUsdOf(proof.gasUnits, nextFee, prices.nativeUsd);
    const bidUsd = this.bidFor(profitUsd, gasUsd);
    if (!this.gate(profitUsd, gasUsd, bidUsd, this.failureUsd(proof.gasUnits, bidUsd, nextFee, prices.nativeUsd), candidate.latencyMs, true).send) {
      evm.rejected++;
      return false;
    }
    evm.proved++;
    evm.modelUsd += candidate.modelProfitUsd;
    evm.evmUsd += profitUsd;
    candidate.profitUsd = profitUsd;
    candidate.gasUnits = proof.gasUnits;
    candidate.gasUsd = gasUsd;
    candidate.bidUsd = bidUsd;
    candidate.worstProfit = proof.profit;
    candidate.usdPerUnit = profitUsd / Number(proof.profit);
    return true;
  }

  private async settle(trade: Pending, header: BlockHeader, prices: Prices): Promise<SettledTrade> {
    const { config } = this;
    const pools = trade.cycle.hops.map((hop) => hop.pool);
    const worstProfitUsd = Number(trade.worstProfit) * trade.usdPerUnit;
    const gasUsd = this.gasUsdOf(trade.gasUnits, header.baseFeeWei, prices.nativeUsd);
    const failureCost = config.mode === 'pays-gas' ? this.failureUsd(trade.gasUnits, trade.bidUsd, header.baseFeeWei, prices.nativeUsd) : 0;

    const closers = [...trade.closedBy];
    const rivalPaymentUsd = closers.length > 0 ? await this.lookup(header.number, closers, prices) : 0;
    const covered = config.builders.size === 0 || config.builders.has(header.miner.toLowerCase());
    const netIfClean = trade.profitUsd - gasUsd - trade.bidUsd;
    const lost = (outcome: Outcome): ScenarioResult => ({ outcome, netUsd: 0 - failureCost });

    // A rival that pays less overall can still go first by paying more for each unit of gas.
    const byTip = config.auction === 'tip-per-gas' && !config.rankedByTotal?.(header.number);
    const turn = byTip ? await this.ourTurn(trade, header.number, this.tipWeiPerGas(trade.bidUsd, trade.gasUnits, prices.nativeUsd)) : undefined;
    const outbid = rivalPaymentUsd >= trade.bidUsd && rivalPaymentUsd > 0;

    const results: Record<Scenario, ScenarioResult> = {
      optimistic: { outcome: 'won', netUsd: netIfClean },
      realistic: !covered ? lost('not-included') : turn ? this.resultAtTurn(trade, turn, gasUsd, lost('lost-to-rival')) : outbid ? lost('lost-to-rival') : { outcome: 'won', netUsd: netIfClean },
      brutal: !covered
        ? lost('not-included')
        : trade.latencyMs * config.brutalLatencyFactor > config.deadlineMs
          ? lost('too-slow')
          : rivalPaymentUsd > 0
            ? lost('lost-to-rival')
            : worstProfitUsd - gasUsd - trade.bidUsd < 0
              ? lost('guard-reverted')
              : { outcome: 'won', netUsd: worstProfitUsd - gasUsd - trade.bidUsd },
    };

    for (const scenario of SCENARIOS) {
      const { outcome, netUsd } = results[scenario];
      const stats = this.stats.scenarios[scenario];
      stats.outcomes[outcome]++;
      stats.netUsd += netUsd;
      stats.balanceUsd += netUsd;
      if (netUsd < 0) stats.losingTrades++;
      if (netUsd > stats.bestUsd) stats.bestUsd = netUsd;
      if (netUsd < stats.worstUsd) stats.worstUsd = netUsd;
    }

    return {
      decidedAtBlock: trade.decidedAtBlock,
      targetBlock: header.number,
      route: trade.cycle.tokens,
      pools,
      amountIn: trade.amountIn.toString(),
      profitUsd: trade.profitUsd,
      modelProfitUsd: trade.modelProfitUsd,
      gasUnits: trade.gasUnits.toString(),
      worstProfitUsd,
      gasUsd,
      bidUsd: trade.bidUsd,
      rivalPaymentUsd,
      touchedByTxs: trade.touchedBy.size,
      closedByTxs: [...trade.closedBy],
      ...(turn ? { atOurTurn: turn } : {}),
      builder: header.miner,
      latencyMs: trade.latencyMs,
      results,
    };
  }

  /** Routes sharing a pool are one mispricing, so only the best of each overlap is counted. */
  private recordMidBlock(routes: ReadonlyMap<string, { cycle: Cycle; usd: number; contributions: GapContribution[] }>, stillOpen: ReadonlySet<string>): void {
    this.lastGaps = [];
    const used = new Set<string>();
    for (const { cycle, usd, contributions } of [...routes.values()].sort((a, b) => b.usd - a.usd)) {
      if (cycle.hops.some((hop) => used.has(hop.pool))) continue;
      for (const hop of cycle.hops) used.add(hop.pool);
      const closedSameBlock = !stillOpen.has(cycle.key);
      this.stats.midBlock.routes++;
      this.stats.midBlock.netOfGasUsd += usd;
      if (closedSameBlock) this.stats.midBlock.closedSameBlock++;
      this.lastGaps.push({ contributions, route: cycle.tokens, pools: cycle.hops.map((hop) => hop.pool), usd, closedSameBlock });
    }
  }
}
