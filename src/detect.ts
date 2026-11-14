import { toEventSelector } from 'viem';

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

export interface Tx {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  success: boolean;
  txIndex: number;
  logs: Log[];
}

export interface ArbHit {
  swaps: number;
  token: string;
  profit: bigint;
  venues: string[];
  pools: string[];
}

export interface LiquidationHit {
  protocol: string;
  /** Lowercase token address -> net change for the sender and executor. Zero nets are omitted. */
  flows: Map<string, bigint>;
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');
const MAX_ROUND_TRIP = 2n;
const DUST_BPS = 10n;
// CoW Protocol settlement keeps solver surplus, which reads like a cycle's gain.
const NON_ARB_EXECUTORS: ReadonlySet<string> = new Set(['0x9008d19f58aabd9ed0d60971565aa8510560ab41']);

const selectorMap = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries).map(([signature, label]) => [toEventSelector(signature), label]));

const SWAP_VENUES = selectorMap({
  'Swap(address,uint256,uint256,uint256,uint256,address)': 'v2',
  'Swap(address,address,int256,int256,uint160,uint128,int24)': 'v3',
  'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)': 'pancake-v3',
  'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)': 'v4',
  'Swap(address,address,uint256,uint256,uint256,uint256)': 'solidly',
  'Swap(bytes32,address,address,uint256,uint256)': 'balancer-v2',
  'Swap(address,address,address,uint256,uint256,uint256,uint256)': 'balancer-v3',
  'Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)': 'trader-joe-lb',
  'TokenExchange(address,int128,uint256,int128,uint256)': 'curve',
  'TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)': 'curve',
  'DODOSwap(address,address,uint256,uint256,address,address)': 'dodo',
});

const LIQUIDATION_PROTOCOLS = selectorMap({
  'LiquidationCall(address,address,address,uint256,uint256,address,bool)': 'aave',
  'Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)': 'morpho',
  'LiquidateBorrow(address,address,uint256,address,uint256)': 'compound-v2',
  'BuyCollateral(address,address,uint256,uint256)': 'compound-v3',
  'Liquidate(address,address,address,uint256,uint256)': 'euler',
});

export const SWAP_TOPICS: ReadonlySet<string> = new Set(SWAP_VENUES.keys());
export const LIQUIDATION_TOPICS: ReadonlySet<string> = new Set(LIQUIDATION_PROTOCOLS.keys());

export const LIQUIDITY_TOPICS: ReadonlySet<string> = new Set(
  [
    'Mint(address,address,int24,int24,uint128,uint256,uint256)',
    'Burn(address,int24,int24,uint128,uint256,uint256)',
    'Collect(address,address,int24,int24,uint128,uint128)',
    'Mint(address,uint256,uint256)',
    'Burn(address,uint256,uint256,address)',
    'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
  ].map((signature) => toEventSelector(signature)),
);

const topicToAddress = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();

const entityOf = (tx: Tx): Set<string> => new Set([tx.from.toLowerCase(), (tx.to ?? tx.from).toLowerCase()]);

function entityFlows(tx: Tx): { received: Map<string, bigint>; sent: Map<string, bigint> } {
  const entity = entityOf(tx);
  const received = new Map<string, bigint>();
  const sent = new Map<string, bigint>();

  for (const log of tx.logs) {
    // Three topics separates ERC-20 from ERC-721, whose tokenId is indexed.
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3 || log.data === '0x') continue;
    const fromEntity = entity.has(topicToAddress(log.topics[1]!));
    const toEntity = entity.has(topicToAddress(log.topics[2]!));
    if (fromEntity === toEntity) continue;

    const token = log.address.toLowerCase();
    const side = toEntity ? received : sent;
    side.set(token, (side.get(token) ?? 0n) + BigInt(log.data));
  }
  return { received, sent };
}

/**
 * Flags a transaction as an atomic arbitrage only when a round trip is directly
 * observable: the sender and executor, taken together, send a token out, get more of
 * that same token back and lose nothing else. Anything that moves liquidity is
 * rejected, because closing or rebalancing a position produces the same net gains.
 *
 * Token flows cannot see native ETH, so anything that sends value is rejected: a
 * native-ETH purchase would otherwise look like a free gain. ETH and WETH count as one
 * asset because wrap and unwrap events are ignored.
 *
 * This favours precision over recall. Arbitrage that pays out to a third address,
 * settles net through V4 or uses native legs is not counted, and neither is CEX-DEX
 * arbitrage, which is one-sided on-chain.
 */
export function detectArb(tx: Tx): ArbHit | null {
  if (!tx.success || tx.to === null || tx.value !== 0n) return null;
  if (NON_ARB_EXECUTORS.has(tx.to.toLowerCase())) return null;

  const venues = new Set<string>();
  const pools: string[] = [];
  for (const log of tx.logs) {
    const topic = log.topics[0];
    if (topic === undefined) continue;
    if (LIQUIDITY_TOPICS.has(topic)) return null;
    const venue = SWAP_VENUES.get(topic);
    if (venue === undefined) continue;
    venues.add(venue);
    pools.push(log.address.toLowerCase());
  }
  if (pools.length < 2) return null;

  const { received, sent } = entityFlows(tx);

  let best: { token: string; profit: bigint } | null = null;
  for (const token of new Set([...received.keys(), ...sent.keys()])) {
    const gross = received.get(token) ?? 0n;
    const spent = sent.get(token) ?? 0n;
    if (gross < spent) return null;
    if (gross === spent) continue;
    if (spent === 0n || gross > spent * MAX_ROUND_TRIP) return null;

    const profit = gross - spent;
    // Rounding can leave dust in an intermediate token; a real second gain cannot be
    // told apart from a rebalance, so it disqualifies the transaction.
    if (profit * 10_000n <= spent * DUST_BPS) {
      best ??= { token, profit };
      continue;
    }
    if (best !== null && best.profit * 10_000n > (sent.get(best.token) ?? 0n) * DUST_BPS) return null;
    best = { token, profit };
  }

  if (best === null) return null;
  return { swaps: pools.length, token: best.token, profit: best.profit, venues: [...venues].sort(), pools };
}

/**
 * Flags a transaction that emits a known lending liquidation event and reports the
 * executor's net token flows. Lending protocols missing from the list are not counted.
 */
export function detectLiquidation(tx: Tx): LiquidationHit | null {
  if (!tx.success || tx.to === null) return null;

  let protocol: string | undefined;
  for (const log of tx.logs) {
    protocol = LIQUIDATION_PROTOCOLS.get(log.topics[0] ?? '');
    if (protocol !== undefined) break;
  }
  if (protocol === undefined) return null;

  const { received, sent } = entityFlows(tx);
  const flows = new Map<string, bigint>();
  for (const token of new Set([...received.keys(), ...sent.keys()])) {
    const net = (received.get(token) ?? 0n) - (sent.get(token) ?? 0n);
    if (net !== 0n) flows.set(token, net);
  }
  return { protocol, flows };
}

/**
 * Wrapped native unwrapped by the sender or executor. Searchers usually pay builders
 * this way, and receipts cannot show that payment, so this bounds the hidden cost.
 */
export function unwrappedBy(tx: Tx, wrappedNative: string): bigint {
  const entity = entityOf(tx);
  let total = 0n;
  for (const log of tx.logs) {
    if (log.topics[0] !== WITHDRAWAL || log.address.toLowerCase() !== wrappedNative || log.topics.length !== 2) continue;
    if (entity.has(topicToAddress(log.topics[1]!))) total += BigInt(log.data);
  }
  return total;
}

/** Net amount of one token the sender and executor gained through Transfer events. */
export function tokenNet(tx: Tx, token: string): bigint {
  const { received, sent } = entityFlows(tx);
  return (received.get(token) ?? 0n) - (sent.get(token) ?? 0n);
}

export const tokensTouched = (tx: Tx): string[] => {
  const tokens = new Set<string>();
  for (const log of tx.logs) {
    if (log.topics[0] === TRANSFER && log.topics.length === 3) tokens.add(log.address.toLowerCase());
  }
  return [...tokens].sort();
};
