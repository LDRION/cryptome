import type { PoolBook, PoolMeta } from './pools.ts';

export interface Hop {
  pool: string;
  zeroForOne: boolean;
}

export interface Cycle {
  key: string;
  start: string;
  tokens: string[];
  hops: Hop[];
}

export interface Trade {
  amountIn: bigint;
  profit: bigint;
}

const GRID_POINTS = 24;
const REFINE_STEPS = 24;
const SCALE = 1_000_000_000n;

/**
 * Lists every two- and three-pool route that starts and ends in a priced token, using
 * only allowed tokens. Each loop appears once, starting from its first priced token.
 */
export function buildCycles(pools: PoolMeta[], starts: ReadonlySet<string>, allowed: ReadonlySet<string>): Cycle[] {
  const usable = pools.filter((p) => allowed.has(p.token0) && allowed.has(p.token1));
  const edges = new Map<string, { pool: PoolMeta; to: string; hop: Hop }[]>();
  const addEdge = (from: string, to: string, pool: PoolMeta, zeroForOne: boolean): void => {
    edges.set(from, [...(edges.get(from) ?? []), { pool, to, hop: { pool: pool.address, zeroForOne } }]);
  };
  for (const pool of usable) {
    addEdge(pool.token0, pool.token1, pool, true);
    addEdge(pool.token1, pool.token0, pool, false);
  }

  const cycles = new Map<string, Cycle>();
  const add = (start: string, tokens: string[], hops: Hop[]): void => {
    const key = hops.map((h) => `${h.pool}:${h.zeroForOne ? 0 : 1}`).sort().join('|');
    if (!cycles.has(key)) cycles.set(key, { key, start, tokens, hops });
  };

  for (const start of [...starts].sort()) {
    for (const first of edges.get(start) ?? []) {
      for (const second of edges.get(first.to) ?? []) {
        if (second.pool === first.pool) continue;
        if (second.to === start) {
          add(start, [start, first.to], [first.hop, second.hop]);
          continue;
        }
        if (second.to === first.to) continue;
        for (const third of edges.get(second.to) ?? []) {
          if (third.to !== start || third.pool === first.pool || third.pool === second.pool) continue;
          add(start, [start, first.to, second.to], [first.hop, second.hop, third.hop]);
        }
      }
    }
  }
  return [...cycles.values()];
}

/** Null when a route is unusable. Above 1 means it pays at the margin, before gas. */
export function marginalReturn(book: PoolBook, cycle: Cycle): number | null {
  let product = 1;
  for (const hop of cycle.hops) {
    const rate = book.rate(hop.pool, hop.zeroForOne);
    if (rate === null) return null;
    product *= rate;
  }
  return product;
}

/** Profit in the start token for a fixed input, or null if any hop leaves the safe range. */
export function cycleProfit(book: PoolBook, cycle: Cycle, amountIn: bigint): bigint | null {
  let amount = amountIn;
  for (const hop of cycle.hops) {
    const out = book.quote(hop.pool, amount, hop.zeroForOne);
    if (out === null || out <= 0n) return null;
    amount = out;
  }
  return amount - amountIn;
}

/**
 * Best input within what the first pool can safely take. Null when nothing is profitable.
 * Below `worthRefining` the rough answer is returned as is: the grid gets within a few
 * percent of the peak, so a result under half of that cannot end up clearing it.
 */
export function bestTrade(book: PoolBook, cycle: Cycle, worthRefining = 0n): Trade | null {
  const first = cycle.hops[0]!;
  const cap = book.maxIn(first.pool, first.zeroForOne);
  if (cap <= 0n) return null;

  const profitAt = (x: bigint): bigint => cycleProfit(book, cycle, x) ?? -1n;
  let best: Trade | null = null;
  let bestIndex = -1;
  const points: bigint[] = [];
  for (let i = 0; i < GRID_POINTS; i++) {
    const factor = BigInt(Math.floor(10 ** ((i - (GRID_POINTS - 1)) / 4) * Number(SCALE)));
    const x = (cap * factor) / SCALE;
    points.push(x);
    if (x <= 0n) continue;
    const profit = profitAt(x);
    if (profit > 0n && (best === null || profit > best.profit)) {
      best = { amountIn: x, profit };
      bestIndex = i;
    } else if (best !== null) {
      // Each extra unit earns less than the last, so past the first drop no size can do better.
      break;
    }
  }
  if (best === null || best.profit * 2n < worthRefining) return best;

  let low = points[Math.max(bestIndex - 1, 0)]!;
  let high = points[Math.min(bestIndex + 1, GRID_POINTS - 1)]!;
  for (let step = 0; step < REFINE_STEPS && high - low > 2n; step++) {
    const third = (high - low) / 3n;
    const a = low + third;
    const b = high - third;
    const profitA = profitAt(a);
    const profitB = profitAt(b);
    if (profitA > best.profit) best = { amountIn: a, profit: profitA };
    if (profitB > best.profit) best = { amountIn: b, profit: profitB };
    if (profitA < profitB) low = a;
    else high = b;
  }
  return best;
}
