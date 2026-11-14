import { toEventSelector } from 'viem';
import { maxInputAcrossTicks, Q96, swapAcrossTicks, v2AmountOut, v3AmountOut, v3MaxIn, v3SwapInRange, type Depth, type V3State } from '../amm.ts';
import { quantile } from '../stats.ts';

export interface PoolMeta {
  /** The contract address, or for V4 the pool id, since all V4 pools share one contract. */
  address: string;
  kind: 'v2' | 'v3' | 'v4';
  token0: string;
  token1: string;
  /** Millionths for V3 and V4. Zero for V2, which uses the standard 0.3%. */
  fee: number;
  tickSpacing: number;
}

export interface PoolLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber?: string;
}

export const V4_POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
export const SYNC = toEventSelector('Sync(uint112,uint112)');
export const V2_SWAP = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');
export const V3_SWAP = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)');
export const PANCAKE_V3_SWAP = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
export const V3_MINT = toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)');
export const V3_BURN = toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)');
export const V4_SWAP = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
export const V4_MODIFY = toEventSelector('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
export const V4_INITIALIZE = toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
export const STATE_TOPICS = [SYNC, V2_SWAP, V3_SWAP, PANCAKE_V3_SWAP, V3_MINT, V3_BURN, V4_SWAP, V4_MODIFY];
export const SWAP_TOPICS: ReadonlySet<string> = new Set([V2_SWAP, V3_SWAP, PANCAKE_V3_SWAP, V4_SWAP]);

const V2_FEE_FACTOR = 0.997;
const MODEL_WINDOW = 20;
const MIN_MODEL_CHECKS = 3;
const MAX_MODEL_ERROR = 0.0005;
const MIN_CHECKED_OUTPUT = 10_000n;
const V2_DEPTH_SHARE = 5n;

const word = (data: string, index: number): bigint => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
const signed = (value: bigint): bigint => BigInt.asIntN(256, value);

/** Identifies the pool a log belongs to, whatever its venue. */
export const poolKeyOf = (log: { address: string; topics?: string[] }): string => {
  const address = log.address.toLowerCase();
  const id = log.topics?.[1];
  return address === V4_POOL_MANAGER && id ? id.toLowerCase() : address;
};

interface V2Live {
  kind: 'v2';
  reserve0: bigint;
  reserve1: bigint;
  previous0: bigint | null;
  previous1: bigint | null;
}
/** V3 and V4 share concentrated-liquidity math and differ only in how their logs read. */
interface RangeLive extends V3State {
  kind: 'range';
}

export class PoolBook {
  readonly metas: Map<string, PoolMeta>;
  private readonly states = new Map<string, V2Live | RangeLive>();
  private readonly recentErrors = new Map<string, number[]>();
  /** Decided once per checked swap, because routes ask about each pool thousands of times a block. */
  private readonly trusted = new Map<string, boolean>();
  private readonly depths = new Map<string, Depth>();
  /** Tracks liquidity changes in the depth reading. Only valid moving forward from the read. */
  trackDepthChanges = false;
  private imagining = false;
  readonly modelErrors = { v2: [] as number[], v3: [] as number[], v4: [] as number[], crossing: [] as number[] };

  constructor(metas: PoolMeta[]) {
    this.metas = new Map(metas.map((meta) => [meta.address, meta]));
  }

  setDepth(key: string, depth: Depth): void {
    this.depths.set(key, depth);
  }

  depthCount(): number {
    return this.depths.size;
  }

  /** For pools whose fee moves. True when it changed, since that can open or close a route. */
  setFee(key: string, fee: number): boolean {
    const meta = this.metas.get(key);
    if (!meta || meta.fee === fee) return false;
    meta.fee = fee;
    const live = this.states.get(key);
    if (live?.kind === 'range') this.states.set(key, { ...live, fee });
    return true;
  }

  /** The pool's current tick, used to decide which part of its depth to read. */
  tickOf(key: string): number | null {
    const live = this.states.get(key);
    return live?.kind === 'range' ? live.tick : null;
  }

  private usableDepth(key: string, tick: number): Depth | null {
    const depth = this.depths.get(key);
    return depth && tick >= depth.lowTick && tick < depth.highTick ? depth : null;
  }

  private adjustDepth(key: string, lower: number, upper: number, delta: bigint): void {
    const depth = this.depths.get(key);
    if (!depth || !this.trackDepthChanges) return;
    const addAt = (tick: number, amount: bigint): void => {
      if (tick < depth.lowTick || tick >= depth.highTick) return;
      const at = depth.ticks.findIndex((entry) => entry.tick >= tick);
      if (at >= 0 && depth.ticks[at]!.tick === tick) depth.ticks[at] = { tick, liquidityNet: depth.ticks[at]!.liquidityNet + amount };
      else if (at >= 0) depth.ticks.splice(at, 0, { tick, liquidityNet: amount });
      else depth.ticks.push({ tick, liquidityNet: amount });
    };
    addAt(lower, delta);
    addAt(upper, -delta);
  }

  /**
   * Shows `look` the book as it would stand after these logs, then puts everything back. Nothing
   * learned here counts as evidence about the model, since these swaps have not really happened.
   */
  whatIf<T>(logs: readonly PoolLog[], look: (changed: ReadonlySet<string>) => T): T {
    const saved = new Map<string, V2Live | RangeLive | undefined>();
    const changed = new Set<string>();
    const tracking = this.trackDepthChanges;
    this.trackDepthChanges = false;
    this.imagining = true;
    try {
      for (const log of logs) {
        const key = poolKeyOf(log);
        if (!saved.has(key)) saved.set(key, this.states.get(key));
        const pool = this.apply(log);
        if (pool !== null) changed.add(pool);
      }
      return look(changed);
    } finally {
      for (const [key, state] of saved) {
        if (state) this.states.set(key, state);
        else this.states.delete(key);
      }
      this.trackDepthChanges = tracking;
      this.imagining = false;
    }
  }

  /** Applies one log and returns the pool whose state it changed, if any. */
  apply(log: PoolLog): string | null {
    const key = poolKeyOf(log);
    const meta = this.metas.get(key);
    const topic = log.topics[0];
    if (!meta || !topic) return null;
    if (meta.kind === 'v2') return this.applyV2(key, topic, log);
    return meta.kind === 'v3' ? this.applyV3(key, meta, topic, log) : this.applyV4(key, meta, topic, log);
  }

  private applyV2(key: string, topic: string, log: PoolLog): string | null {
    if (topic === SYNC) {
      const live = this.states.get(key) as V2Live | undefined;
      this.states.set(key, {
        kind: 'v2',
        reserve0: word(log.data, 0),
        reserve1: word(log.data, 1),
        previous0: live?.reserve0 ?? null,
        previous1: live?.reserve1 ?? null,
      });
      return key;
    }
    if (topic === V2_SWAP) {
      // A V2 pool emits Sync just before Swap, so the previous reserves are the pre-trade state.
      const live = this.states.get(key) as V2Live | undefined;
      if (!live || live.previous0 === null || live.previous1 === null) return null;
      const [in0, in1, out0, out1] = [word(log.data, 0), word(log.data, 1), word(log.data, 2), word(log.data, 3)];
      if (in0 > 0n && in1 === 0n) this.check('v2', key, v2AmountOut(in0, live.previous0, live.previous1), out1);
      if (in1 > 0n && in0 === 0n) this.check('v2', key, v2AmountOut(in1, live.previous1, live.previous0), out0);
    }
    return null;
  }

  private applyV3(key: string, meta: PoolMeta, topic: string, log: PoolLog): string | null {
    const live = this.states.get(key) as RangeLive | undefined;

    if (topic === V3_SWAP || topic === PANCAKE_V3_SWAP) {
      // V3 logs the pool's side: a positive amount is what the pool received.
      const amount0 = signed(word(log.data, 0));
      const amount1 = signed(word(log.data, 1));
      const next = this.rangeState(meta, log, meta.fee);
      this.checkRange('v3', key, live, next, amount0 > 0n, amount0 > 0n ? amount0 : amount1, amount0 > 0n ? -amount1 : -amount0);
      this.states.set(key, next);
      return key;
    }

    if ((topic === V3_MINT || topic === V3_BURN) && live) {
      const lower = Number(signed(BigInt(log.topics[2]!)));
      const upper = Number(signed(BigInt(log.topics[3]!)));
      const amount = word(log.data, topic === V3_MINT ? 1 : 0);
      const delta = topic === V3_MINT ? amount : -amount;
      this.adjustDepth(key, lower, upper, delta);
      return this.changeLiquidity(key, live, lower, upper, delta);
    }
    return null;
  }

  private applyV4(key: string, meta: PoolMeta, topic: string, log: PoolLog): string | null {
    const live = this.states.get(key) as RangeLive | undefined;

    if (topic === V4_SWAP) {
      // V4 logs the swapper's side: a negative amount is what the swapper paid in.
      const amount0 = signed(word(log.data, 0));
      const amount1 = signed(word(log.data, 1));
      const fee = Number(word(log.data, 5));
      const next = this.rangeState(meta, log, fee);
      this.checkRange('v4', key, live && { ...live, fee }, next, amount0 < 0n, amount0 < 0n ? -amount0 : -amount1, amount0 < 0n ? amount1 : amount0);
      this.states.set(key, next);
      return key;
    }

    if (topic === V4_MODIFY && live) {
      const lower = Number(signed(word(log.data, 0)));
      const upper = Number(signed(word(log.data, 1)));
      const delta = signed(word(log.data, 2));
      this.adjustDepth(key, lower, upper, delta);
      return this.changeLiquidity(key, live, lower, upper, delta);
    }
    return null;
  }

  private rangeState(meta: PoolMeta, log: PoolLog, fee: number): RangeLive {
    return {
      kind: 'range',
      sqrtPriceX96: word(log.data, 2),
      liquidity: word(log.data, 3),
      tick: Number(signed(word(log.data, 4))),
      fee,
      tickSpacing: meta.tickSpacing,
    };
  }

  private changeLiquidity(key: string, live: RangeLive, lower: number, upper: number, delta: bigint): string | null {
    if (live.tick < lower || live.tick >= upper) return null;
    this.states.set(key, { ...live, liquidity: live.liquidity + delta });
    return key;
  }

  private checkRange(kind: 'v3' | 'v4', key: string, before: RangeLive | undefined, after: RangeLive, zeroForOne: boolean, amountIn: bigint, actualOut: bigint): void {
    if (this.imagining || !before || amountIn <= 0n || actualOut <= 0n) return;
    if (before.liquidity === after.liquidity) {
      this.check(kind, key, v3SwapInRange(before, amountIn, zeroForOne).amountOut, actualOut);
      return;
    }
    // Liquidity changed, so the swap crossed a tick. Kept apart, because this checks the
    // depth reading as well as the math, and a stale reading must not distrust the pool.
    const depth = this.usableDepth(key, before.tick);
    const predicted = depth ? swapAcrossTicks(before, depth, amountIn, zeroForOne) : null;
    if (predicted && actualOut >= MIN_CHECKED_OUTPUT) {
      this.modelErrors.crossing.push(Math.abs(Number(predicted.amountOut - actualOut)) / Number(actualOut));
    }
  }

  private check(kind: 'v2' | 'v3' | 'v4', key: string, predicted: bigint, actual: bigint): void {
    if (this.imagining || actual < MIN_CHECKED_OUTPUT) return;
    const error = Math.abs(Number(predicted - actual)) / Number(actual);
    this.modelErrors[kind].push(error);
    const recent = this.recentErrors.get(key) ?? [];
    recent.push(error);
    if (recent.length > MODEL_WINDOW) recent.shift();
    this.recentErrors.set(key, recent);
    this.trusted.set(key, recent.length >= MIN_MODEL_CHECKS && quantile(recent, 0.5) <= MAX_MODEL_ERROR);
  }

  /** True once real swaps on this pool have matched the model closely enough to trust it. */
  isVerified(key: string): boolean {
    return this.trusted.get(key) ?? false;
  }

  isReady(key: string): boolean {
    const live = this.states.get(key);
    if (!live) return false;
    return live.kind === 'v2' ? live.reserve0 > 0n && live.reserve1 > 0n : live.liquidity > 0n;
  }

  quote(key: string, amountIn: bigint, zeroForOne: boolean): bigint | null {
    const live = this.states.get(key);
    if (!live) return null;
    if (live.kind === 'v2') {
      const [reserveIn, reserveOut] = zeroForOne ? [live.reserve0, live.reserve1] : [live.reserve1, live.reserve0];
      return amountIn > reserveIn / V2_DEPTH_SHARE ? null : v2AmountOut(amountIn, reserveIn, reserveOut);
    }
    const depth = this.usableDepth(key, live.tick);
    if (depth) return swapAcrossTicks(live, depth, amountIn, zeroForOne)?.amountOut ?? null;
    return v3AmountOut(live, amountIn, zeroForOne);
  }

  maxIn(key: string, zeroForOne: boolean): bigint {
    const live = this.states.get(key);
    if (!live) return 0n;
    if (live.kind === 'v2') return (zeroForOne ? live.reserve0 : live.reserve1) / V2_DEPTH_SHARE;
    const depth = this.usableDepth(key, live.tick);
    return depth ? maxInputAcrossTicks(live, depth, zeroForOne) : v3MaxIn(live, zeroForOne);
  }

  /** The pool's price now, in the form the contract compares when it works out the gap. */
  priceForContract(key: string, zeroForOne: boolean): bigint {
    const live = this.states.get(key);
    if (!live) return 0n;
    if (live.kind === 'v2') {
      const [reserveIn, reserveOut] = zeroForOne ? [live.reserve0, live.reserve1] : [live.reserve1, live.reserve0];
      return reserveIn === 0n ? 0n : (reserveOut << 96n) / reserveIn;
    }
    return live.sqrtPriceX96;
  }

  /** Marginal output per unit of input after the fee, used to skip routes cheaply. */
  rate(key: string, zeroForOne: boolean): number | null {
    const live = this.states.get(key);
    if (!live) return null;
    if (live.kind === 'v2') {
      if (live.reserve0 === 0n || live.reserve1 === 0n) return null;
      const price = Number(live.reserve1) / Number(live.reserve0);
      return (zeroForOne ? price : 1 / price) * V2_FEE_FACTOR;
    }
    const root = Number(live.sqrtPriceX96) / Number(Q96);
    const price = root * root;
    return (zeroForOne ? price : 1 / price) * (1 - live.fee / 1e6);
  }
}
