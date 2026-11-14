/**
 * Turns a proven trade into the exact terms of a public transaction. Pure arithmetic with no
 * keys and no network, so every number that would go on chain can be tested and logged first.
 */

export interface PlanInput {
  /** Proven profit in whole dollars, and the rate to express amounts in the start token. */
  profitUsd: number;
  bidUsd: number;
  usdPerStartUnit: number;
  gasUnits: bigint;
  nextBaseFeeWei: bigint;
  nativeUsd: number;
  /** Timestamp of the block the trade was decided on, in seconds. */
  decidedBlockTimestamp: number;
  decidedBlock: number;
  failureGasUnits: bigint;
  minNetUsd: number;
  /** When taking over the nonce of an attempt still out, nodes demand more than it paid. */
  atLeastTipWei?: bigint;
  atLeastMaxFeeWei?: bigint;
}

export interface TxPlan {
  targetBlock: number;
  gasLimit: bigint;
  tipWeiPerGas: bigint;
  maxFeePerGas: bigint;
  /** What the contract must end up with, in start token units, or the whole trade reverts. */
  minProfitUnits: bigint;
  /** Cost if this attempt stops at its price check. */
  failureCostUsd: number;
  gasUsd: number;
  /** The moment to send, as close to the block as is still safe. */
  sendAtMs: number;
}

const SECONDS_PER_SLOT = 12;
/** Room for the attempt using more gas than it did when proven. */
const GAS_LIMIT_MARGIN_PERCENT = 120n;
/**
 * Some pools refuse to finish a swap unless a lot of gas is still left, however little the swap uses:
 * WBTC/USDT at 0x941ddc62 answers "IG" below about 572k on a route that uses 369k. Unused gas is not
 * paid for, so this only raises what a hostile route could burn before its pools are quarantined.
 */
const ROUTE_GAS_RESERVE = 200_000n;
/**
 * How long before the block to send. Sending later shows more of the mempool and gives anyone
 * copying the route less time. Transactions spread in under a second through the nodes we use, and
 * self-built blocks hold transactions first seen as little as 2 s before the block.
 */
export const SEND_LEAD_MS = 4000;
/**
 * Below this a tip was left behind by full blocks: real attempts at 0.016-0.025 gwei missed
 * blocks whose median tip was 0.15. It is small next to any trade worth sending.
 */
export const MIN_TIP_WEI_PER_GAS = 100_000_000n;

const usdOfWei = (wei: bigint, nativeUsd: number): number => (Number(wei) / 1e18) * nativeUsd;
const largest = (...values: bigint[]): bigint => values.reduce((a, b) => (a > b ? a : b));

export const PLAIN_TRANSFER_GAS = 21_000n;

/** What can leave a wallet when emptying it, so that exactly the transfer's own fee stays behind. Zero when even that fee is out of reach. */
export function emptyingAmount(balanceWei: bigint, maxFeePerGas: bigint): bigint {
  const fee = PLAIN_TRANSFER_GAS * maxFeePerGas;
  return balanceWei > fee ? balanceWei - fee : 0n;
}

export interface BatchTrade {
  profitUsd: number;
  bidUsd: number;
  usdPerStartUnit: number;
  gasUnits: bigint;
  /** The route's gap when decided, as a fraction of 1e18. */
  startGap: bigint;
}

export interface BatchInput extends Omit<PlanInput, 'profitUsd' | 'bidUsd' | 'usdPerStartUnit' | 'gasUnits'> {
  trades: readonly BatchTrade[];
  maxRoutes?: number;
  /** Pays exactly this, for a trade that must stay behind a transaction paying only a little more. */
  exactTipWei?: bigint;
  /** The bid may not go above this, as more would not fit the limits or the balance. */
  atMostTipWei?: bigint;
}

export interface BatchPlan extends Omit<TxPlan, 'minProfitUnits'> {
  /** Best first. `index` points back into the trades given. */
  routes: { index: number; minProfitUnits: bigint; minGap: bigint; gasLimit: bigint }[];
}

const MAX_ROUTES = 8;
/** Eight routes of about 500k gas, each with its margin and reserve. */
const MAX_BATCH_GAS = 6_600_000n;
/** What each further route burns if it stops at its price check: its calldata and the check. */
const FAILED_ROUTE_GAS = 30_000n;

/**
 * Terms of one transaction carrying every trade that pays for itself. One tip covers them all,
 * since that is how the block orders it, and each route must cover its own share of the costs.
 */
export function planBatch(input: BatchInput): BatchPlan | null {
  const { nextBaseFeeWei, nativeUsd } = input;
  if (!(nativeUsd > 0)) return null;
  const valid = input.trades
    .map((trade, index) => ({ ...trade, index }))
    .filter((trade) => trade.gasUnits > 0n && trade.usdPerStartUnit > 0 && trade.bidUsd >= 0)
    .sort((a, b) => b.profitUsd - a.profitUsd);

  let chosen: typeof valid = [];
  let gasLimit = 0n;
  const routeGasLimit = (gasUnits: bigint): bigint => (gasUnits * GAS_LIMIT_MARGIN_PERCENT) / 100n + ROUTE_GAS_RESERVE;
  for (const trade of valid) {
    if (chosen.length === (input.maxRoutes ?? MAX_ROUTES) || gasLimit + routeGasLimit(trade.gasUnits) > MAX_BATCH_GAS) break;
    chosen.push(trade);
    gasLimit += routeGasLimit(trade.gasUnits);
  }

  // Dropping a route changes the tip, which can change who else pays for itself.
  while (chosen.length > 0) {
    const gasUnits = chosen.reduce((total, trade) => total + trade.gasUnits, 0n);
    const bidUsd = chosen.reduce((total, trade) => total + trade.bidUsd, 0);
    const bidTip = BigInt(Math.ceil(((bidUsd / nativeUsd) * 1e18) / Number(gasUnits)));
    const bid = input.atMostTipWei !== undefined && input.atMostTipWei < bidTip ? input.atMostTipWei : bidTip;
    const tipWeiPerGas = input.exactTipWei ?? largest(bid, MIN_TIP_WEI_PER_GAS, input.atLeastTipWei ?? 0n);
    const costOf = (trade: BatchTrade): number => usdOfWei(trade.gasUnits * (nextBaseFeeWei + tipWeiPerGas), nativeUsd) + input.minNetUsd;
    const paying = chosen.filter((trade) => trade.profitUsd >= costOf(trade));
    if (paying.length < chosen.length) {
      chosen = paying;
      continue;
    }
    const maxFeePerGas = largest(nextBaseFeeWei + tipWeiPerGas, input.atLeastMaxFeeWei ?? 0n);
    const failureGas = input.failureGasUnits + FAILED_ROUTE_GAS * BigInt(chosen.length - 1);
    return {
      targetBlock: input.decidedBlock + 1,
      gasLimit: chosen.reduce((total, trade) => total + routeGasLimit(trade.gasUnits), 0n),
      tipWeiPerGas,
      maxFeePerGas,
      failureCostUsd: usdOfWei(failureGas * maxFeePerGas, nativeUsd),
      gasUsd: usdOfWei(gasUnits * nextBaseFeeWei, nativeUsd),
      sendAtMs: (input.decidedBlockTimestamp + SECONDS_PER_SLOT) * 1000 - SEND_LEAD_MS,
      routes: chosen.map((trade) => ({
        index: trade.index,
        // The contract refuses to finish a route with less than that route will have paid to happen.
        minProfitUnits: BigInt(Math.ceil(costOf(trade) / trade.usdPerStartUnit)),
        // Profit falls with the square of the gap, so this is the narrowest that still covers the costs.
        minGap: BigInt(Math.ceil(Number(trade.startGap) * Math.sqrt(costOf(trade) / trade.profitUsd))),
        gasLimit: routeGasLimit(trade.gasUnits),
      })),
    };
  }
  return null;
}

/**
 * About 8% of attempts aim at a self-built block, and about two thirds of those win, so one win
 * comes with this many failures. Real attempts agree: 2 wins in 45. When the base fee jumps a failure
 * can cost 40 cents instead of 2, and this is what stops small trades from burning money then.
 */
export const FAILURES_PER_WIN = 18;
/** What a failed attempt burns. */
const FAILED_ATTEMPT_GAS = 50_000n;

export interface OpenBookTrade {
  profitUsd: number;
  gasUnits: bigint;
  /** The tip that goes ahead of every pending transaction that would close this route. Zero if none would. */
  needTipWei: bigint;
}

export interface OpenBookInput {
  trades: readonly OpenBookTrade[];
  baseTipWei: bigint;
  nextBaseFeeWei: bigint;
  nativeUsd: number;
  minNetUsd: number;
  /** Expected in this very slot, when its odds are known. */
  failuresPerWin?: number;
}

/**
 * A block ordered by tip is an open book: the bids to beat are in the mempool. So the tip is chosen
 * by what each level would actually keep, after the failures that come with each win at that price.
 * A route still closed at the chosen level is left out, as sending it could only burn gas. Null when
 * no level leaves anything worth sending, whether because of rivals or because gas costs too much.
 */
export function chooseTip(input: OpenBookInput): { tipWei: bigint; keep: number[] } | null {
  const { baseTipWei, nextBaseFeeWei, nativeUsd, minNetUsd } = input;
  const failures = input.failuresPerWin ?? FAILURES_PER_WIN;
  const usd = (gas: bigint, tip: bigint): number => usdOfWei(gas * (nextBaseFeeWei + tip), nativeUsd);
  const levels = [baseTipWei, ...input.trades.map((trade) => trade.needTipWei).filter((need) => need > baseTipWei)];
  let best: { tipWei: bigint; keep: number[]; value: number } | null = null;
  for (const tip of levels) {
    const earned = (i: number): number => input.trades[i]!.profitUsd - usd(input.trades[i]!.gasUnits, tip);
    const open = input.trades.flatMap((trade, i) => (trade.needTipWei <= tip && trade.profitUsd >= usd(trade.gasUnits, tip) + minNetUsd ? [i] : []));
    if (open.length === 0) continue;
    const top = open.reduce((leader, i) => (earned(i) > earned(leader) ? i : leader));
    // Each further route burns more in every failed attempt, so it has to pay for that as well.
    const keep = open.filter((i) => i === top || earned(i) > usd(FAILED_ROUTE_GAS, tip) * failures);
    const failureGas = FAILED_ATTEMPT_GAS + FAILED_ROUTE_GAS * BigInt(keep.length - 1);
    const value = keep.reduce((total, i) => total + earned(i), 0) - usd(failureGas, tip) * failures;
    if (!best || value > best.value) best = { tipWei: tip, keep, value };
  }
  return best && best.value > 0 ? { tipWei: best.tipWei, keep: best.keep } : null;
}

/** Up to this share of the profit is worth paying to stay ahead of rivals that turn up later. */
const BACKRUN_GUARD_SHARE = 0.1;

export interface BackrunInput {
  profitUsd: number;
  gasUnits: bigint;
  /** The transaction that opens the gap. Paying less than it is what puts us right behind it. */
  openerTipWei: bigint;
  /** The most any known rival pays below the opener. Zero if there is none. */
  rivalTipWei: bigint;
  nextBaseFeeWei: bigint;
  nativeUsd: number;
  minNetUsd: number;
  /** Expected in this very slot, when its odds are known. */
  failuresPerWin?: number;
}

/**
 * The tip that lands right behind a pending transaction, or null if there is no room or it would
 * not pay. Equal tips leave the order to chance, so it must be strictly between the two. The trade
 * must also cover the attempts that fail in all the other blocks, where the opener lands anyway.
 */
export function backrunTip(input: BackrunInput): bigint | null {
  const { gasUnits, openerTipWei, rivalTipWei, nextBaseFeeWei, nativeUsd, profitUsd } = input;
  const lowest = rivalTipWei + 1n;
  if (lowest >= openerTipWei || gasUnits <= 0n || !(nativeUsd > 0)) return null;
  const guard = BigInt(Math.floor((((profitUsd * BACKRUN_GUARD_SHARE) / nativeUsd) * 1e18) / Number(gasUnits)));
  const wanted = largest(lowest, guard);
  const tip = wanted < openerTipWei ? wanted : openerTipWei - 1n;
  const net = profitUsd - usdOfWei(gasUnits * (nextBaseFeeWei + tip), nativeUsd);
  if (net < input.minNetUsd) return null;
  return net >= usdOfWei(FAILED_ATTEMPT_GAS * (nextBaseFeeWei + tip), nativeUsd) * (input.failuresPerWin ?? FAILURES_PER_WIN) ? tip : null;
}

export function planAttempt(input: PlanInput): TxPlan | null {
  const { gasUnits, nextBaseFeeWei, nativeUsd, bidUsd, profitUsd, usdPerStartUnit } = input;
  if (gasUnits <= 0n || !(nativeUsd > 0) || !(usdPerStartUnit > 0) || !(bidUsd >= 0)) return null;

  const bidTip = BigInt(Math.ceil(((bidUsd / nativeUsd) * 1e18) / Number(gasUnits)));
  const tipWeiPerGas = largest(bidTip, MIN_TIP_WEI_PER_GAS, input.atLeastTipWei ?? 0n);
  // The next base fee is known exactly, and the target is only the next block.
  const maxFeePerGas = largest(nextBaseFeeWei + tipWeiPerGas, input.atLeastMaxFeeWei ?? 0n);
  const gasUsd = usdOfWei(gasUnits * nextBaseFeeWei, nativeUsd);
  const costsUsd = gasUsd + usdOfWei(gasUnits * tipWeiPerGas, nativeUsd);
  if (profitUsd < costsUsd + input.minNetUsd) return null;

  // The contract refuses to finish with less than the trade will have paid to happen.
  const minProfitUnits = BigInt(Math.ceil((costsUsd + input.minNetUsd) / usdPerStartUnit));
  return {
    targetBlock: input.decidedBlock + 1,
    gasLimit: (gasUnits * GAS_LIMIT_MARGIN_PERCENT) / 100n,
    tipWeiPerGas,
    maxFeePerGas,
    minProfitUnits,
    failureCostUsd: usdOfWei(input.failureGasUnits * maxFeePerGas, nativeUsd),
    gasUsd,
    sendAtMs: (input.decidedBlockTimestamp + SECONDS_PER_SLOT) * 1000 - SEND_LEAD_MS,
  };
}
