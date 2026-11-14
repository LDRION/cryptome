export const Q96 = 1n << 96n;
const PPM = 1_000_000n;

export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 30n): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * (10_000n - feeBps);
  return (withFee * reserveOut) / (reserveIn * 10_000n + withFee);
}

export interface V3State {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  /** Fee in millionths, as the pool reports it. */
  fee: number;
  tickSpacing: number;
}

export const sqrtPriceAtTick = (tick: number): bigint => BigInt(Math.floor(1.0001 ** (tick / 2) * 2 ** 96));

/** Swap math while liquidity stays constant. The caller decides whether that holds. */
export function v3SwapInRange(state: V3State, amountIn: bigint, zeroForOne: boolean): { amountOut: bigint; sqrtPriceX96: bigint } {
  const { sqrtPriceX96: price, liquidity } = state;
  const net = (amountIn * (PPM - BigInt(state.fee))) / PPM;
  if (net <= 0n || liquidity <= 0n) return { amountOut: 0n, sqrtPriceX96: price };

  if (zeroForOne) {
    const numerator = liquidity * Q96 * price;
    const denominator = liquidity * Q96 + net * price;
    const next = (numerator + denominator - 1n) / denominator;
    return { amountOut: (liquidity * (price - next)) / Q96, sqrtPriceX96: next };
  }
  const next = price + (net * Q96) / liquidity;
  return { amountOut: (liquidity * Q96 * (next - price)) / next / price, sqrtPriceX96: next };
}

/**
 * Largest input guaranteed to keep liquidity constant. Past logs do not reveal which
 * ticks hold liquidity, but none can change inside one tick spacing. This understates
 * large trades on purpose, because overstating depth would produce false profit.
 */
export function v3MaxIn(state: V3State, zeroForOne: boolean): bigint {
  const { sqrtPriceX96: price, liquidity } = state;
  if (liquidity <= 0n) return 0n;
  const lower = Math.floor(state.tick / state.tickSpacing) * state.tickSpacing;
  const target = sqrtPriceAtTick(zeroForOne ? lower : lower + state.tickSpacing);

  let net: bigint;
  if (zeroForOne) {
    if (target >= price) return 0n;
    net = (liquidity * Q96 * (price - target)) / (price * target);
  } else {
    if (target <= price) return 0n;
    net = (liquidity * (target - price)) / Q96;
  }
  return (net * PPM) / (PPM - BigInt(state.fee));
}

/** Null when the input could cross into liquidity the model cannot see. */
export function v3AmountOut(state: V3State, amountIn: bigint, zeroForOne: boolean): bigint | null {
  if (amountIn > v3MaxIn(state, zeroForOne)) return null;
  return v3SwapInRange(state, amountIn, zeroForOne).amountOut;
}

export interface TickEntry {
  tick: number;
  liquidityNet: bigint;
}

/** Initialized ticks read from the chain, sorted, and the tick range that reading covers. */
export interface Depth {
  ticks: TickEntry[];
  lowTick: number;
  highTick: number;
}

export interface CrossingSwap {
  amountOut: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  crossed: number;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Input needed to move price to a target with constant liquidity, fee included. */
function grossInputTo(price: bigint, target: bigint, liquidity: bigint, fee: number, zeroForOne: boolean): bigint {
  const net = zeroForOne ? ceilDiv(liquidity * Q96 * (price - target), price * target) : ceilDiv(liquidity * (target - price), Q96);
  return ceilDiv(net * PPM, PPM - BigInt(fee));
}

function outputTo(price: bigint, target: bigint, liquidity: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? (liquidity * (price - target)) / Q96 : (liquidity * Q96 * (target - price)) / target / price;
}

/**
 * Walks a swap through initialized ticks, changing liquidity at each one. Null when it
 * would leave the range the depth reading covers, where liquidity is unknown.
 */
export function swapAcrossTicks(state: V3State, depth: Depth, amountIn: bigint, zeroForOne: boolean): CrossingSwap | null {
  let remaining = amountIn;
  let price = state.sqrtPriceX96;
  let liquidity = state.liquidity;
  let out = 0n;
  let crossed = 0;

  // Moving down crosses the tick at or below the current one; moving up, the next above it.
  let index = zeroForOne ? depth.ticks.findLastIndex((entry) => entry.tick <= state.tick) : depth.ticks.findIndex((entry) => entry.tick > state.tick);

  while (remaining > 0n) {
    const next = index >= 0 && index < depth.ticks.length ? depth.ticks[index]! : null;
    const edge = next ? next.tick : zeroForOne ? depth.lowTick : depth.highTick;
    const target = sqrtPriceAtTick(edge);
    const reachable = zeroForOne ? target < price : target > price;

    if (reachable && liquidity > 0n) {
      const needed = grossInputTo(price, target, liquidity, state.fee, zeroForOne);
      if (remaining < needed) {
        const step = v3SwapInRange({ ...state, sqrtPriceX96: price, liquidity }, remaining, zeroForOne);
        return { amountOut: out + step.amountOut, sqrtPriceX96: step.sqrtPriceX96, liquidity, crossed };
      }
      out += outputTo(price, target, liquidity, zeroForOne);
      remaining -= needed;
    }
    if (next === null) return null;

    if (reachable) price = target;
    liquidity += zeroForOne ? -next.liquidityNet : next.liquidityNet;
    if (liquidity < 0n) return null;
    crossed++;
    index += zeroForOne ? -1 : 1;
  }
  return { amountOut: out, sqrtPriceX96: price, liquidity, crossed };
}

/** Largest input that stays inside the range the depth reading covers. */
export function maxInputAcrossTicks(state: V3State, depth: Depth, zeroForOne: boolean): bigint {
  let price = state.sqrtPriceX96;
  let liquidity = state.liquidity;
  let total = 0n;
  let index = zeroForOne ? depth.ticks.findLastIndex((entry) => entry.tick <= state.tick) : depth.ticks.findIndex((entry) => entry.tick > state.tick);

  for (;;) {
    const next = index >= 0 && index < depth.ticks.length ? depth.ticks[index]! : null;
    const target = sqrtPriceAtTick(next ? next.tick : zeroForOne ? depth.lowTick : depth.highTick);
    const reachable = zeroForOne ? target < price : target > price;
    if (reachable && liquidity > 0n) total += grossInputTo(price, target, liquidity, state.fee, zeroForOne);
    if (next === null) return total;
    if (reachable) price = target;
    liquidity += zeroForOne ? -next.liquidityNet : next.liquidityNet;
    if (liquidity < 0n) return total;
    index += zeroForOne ? -1 : 1;
  }
}

/** EIP-1559: the next block's base fee is fully determined by the current header. */
export function nextBaseFee(baseFee: bigint, gasUsed: bigint, gasLimit: bigint): bigint {
  const target = gasLimit / 2n;
  if (target === 0n || gasUsed === target) return baseFee;
  if (gasUsed > target) {
    const delta = (baseFee * (gasUsed - target)) / target / 8n;
    return baseFee + (delta > 1n ? delta : 1n);
  }
  return baseFee - (baseFee * (target - gasUsed)) / target / 8n;
}
