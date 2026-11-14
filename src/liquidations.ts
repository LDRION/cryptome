import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { toEventSelector } from 'viem';
import { CHAINS } from './chains.ts';
import { createRpc, mapLimit, type Rpc } from './rpc.ts';
import { quantile, sum } from './stats.ts';
import { nativeFlows, type CallFrame } from './trace.ts';

/**
 * Sizes Aave V3 liquidations from the protocol's own events and oracle prices. Unlike
 * arbitrage, a liquidation is tied to one borrower's position, so holding inventory on an
 * exchange gives no edge, which is why this niche is measured separately.
 */

const { values: args } = parseArgs({
  options: {
    chain: { type: 'string', default: 'ethereum' },
    // Spark is a fork of Aave V3 with the same event and oracle, so the same measure applies.
    market: { type: 'string' },
    days: { type: 'string', default: '7' },
    'block-seconds': { type: 'string' },
    // Free plans refuse wider log ranges, and splitting after each refusal costs far more.
    'log-chunk': { type: 'string', default: '100' },
    traced: { type: 'string', default: '40' },
    concurrency: { type: 'string', default: '3' },
  },
});

interface Market {
  pool: string;
  oracle: string;
  blockSeconds: number;
}

const MARKETS: Record<string, Market> = {
  ethereum: { pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2', blockSeconds: 12 },
  base: { pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156', blockSeconds: 2 },
  arbitrum: { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7', blockSeconds: 0.25 },
  bsc: { pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', oracle: '0x39bc1bfDa2130d6Bb6DBEfd366939b4c7aa7C697', blockSeconds: 0.45 },
  spark: { pool: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987', oracle: '0x8105f69D9C41644c6A0803fDA7D03Aa70996cFD9', blockSeconds: 12 },
};

const LIQUIDATION_CALL = toEventSelector('LiquidationCall(address,address,address,uint256,uint256,address,bool)');
const DECIMALS = '0x313ce567';
const GET_ASSET_PRICE = '0xb3596f07';
const ORACLE_DECIMALS = 8;

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

const word = (data: string, index: number): bigint => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
const addressOf = (topic: string): string => `0x${topic.slice(-40)}`;

/** Halves the range when a node refuses its size. */
async function logsBetween(rpc: Rpc, pool: string, from: number, to: number): Promise<RawLog[]> {
  try {
    return await rpc.call<RawLog[]>('eth_getLogs', [{ address: pool, topics: [LIQUIDATION_CALL], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
  } catch (err) {
    if (to <= from) throw err;
    const middle = Math.floor((from + to) / 2);
    return [...(await logsBetween(rpc, pool, from, middle)), ...(await logsBetween(rpc, pool, middle + 1, to))];
  }
}

const chain = CHAINS[args.chain];
const market = MARKETS[args.market ?? args.chain];
if (!chain || !market) throw new Error(`No Aave market known for ${args.market ?? args.chain}`);
const url = process.env[`TRACE_RPC_URL_${chain.name.toUpperCase()}`] ?? chain.defaultTraceRpc;
if (!url) throw new Error(`No endpoint for ${chain.name}`);
const rpc = createRpc(url, 7);

const blockSeconds = args['block-seconds'] ? Number(args['block-seconds']) : market.blockSeconds;
const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
const from = head - Math.floor((Number(args.days) * 86_400) / blockSeconds);
const chunk = Number(args['log-chunk']);
const starts: number[] = [];
for (let start = from; start <= head; start += chunk) starts.push(start);
console.error(`${chain.name}: ${head - from} blocks in ${starts.length} chunks`);

let chunksDone = 0;
const logs = (
  await mapLimit(starts, Number(args.concurrency), async (start) => {
    const found = await logsBetween(rpc, market.pool, start, Math.min(start + chunk - 1, head));
    if (++chunksDone % 50 === 0) console.error(`  ${chunksDone}/${starts.length}`);
    return found;
  })
).flat();
console.error(`${logs.length} liquidations`);

const decimalsOf = new Map<string, Promise<number>>();
const decimals = (token: string): Promise<number> => {
  let known = decimalsOf.get(token);
  if (!known) {
    known = rpc.call<string>('eth_call', [{ to: token, data: DECIMALS }, 'latest']).then((raw) => Number(BigInt(raw)));
    decimalsOf.set(token, known);
  }
  return known;
};
const priceAt = async (token: string, tag: string): Promise<number> => {
  const raw = await rpc.call<string>('eth_call', [{ to: market.oracle, data: `${GET_ASSET_PRICE}${token.slice(2).padStart(64, '0')}` }, tag]);
  return Number(BigInt(raw)) / 10 ** ORACLE_DECIMALS;
};

const priced = (
  await mapLimit(logs, Number(args.concurrency), async (log) => {
    try {
      const [collateral, debt] = [addressOf(log.topics[1]!), addressOf(log.topics[2]!)];
      const [collateralDecimals, debtDecimals, collateralPrice, debtPrice] = await Promise.all([decimals(collateral), decimals(debt), priceAt(collateral, log.blockNumber), priceAt(debt, log.blockNumber)]);
      const debtUsd = (Number(word(log.data, 0)) / 10 ** debtDecimals) * debtPrice;
      const collateralUsd = (Number(word(log.data, 1)) / 10 ** collateralDecimals) * collateralPrice;
      return {
        block: Number(BigInt(log.blockNumber)),
        hash: log.transactionHash,
        liquidator: `0x${log.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)}`,
        debtUsd,
        collateralUsd,
        grossUsd: collateralUsd - debtUsd,
      };
    } catch {
      return null;
    }
  })
).filter((entry) => entry !== null);

const days = Number(args.days);
const grossAll = sum(priced.map((entry) => entry.grossUsd));
const byLiquidator = new Map<string, { count: number; grossUsd: number }>();
for (const entry of priced) {
  const known = byLiquidator.get(entry.liquidator) ?? { count: 0, grossUsd: 0 };
  known.count++;
  known.grossUsd += entry.grossUsd;
  byLiquidator.set(entry.liquidator, known);
}
const leaders = [...byLiquidator].sort((a, b) => b[1].grossUsd - a[1].grossUsd);

// The largest ones decide the money, so those are the ones checked for what reached the builder.
const largest = [...priced].sort((a, b) => b.grossUsd - a.grossUsd).slice(0, Number(args.traced));
const paid = await mapLimit(largest, Number(args.concurrency), async (entry) => {
  try {
    const tag = `0x${entry.block.toString(16)}`;
    const [block, receipt, trace, major] = await Promise.all([
      rpc.call<{ miner: string; baseFeePerGas?: string }>('eth_getBlockByNumber', [tag, false]),
      rpc.call<{ gasUsed: string; effectiveGasPrice: string }>('eth_getTransactionReceipt', [entry.hash]),
      rpc.call<CallFrame>('debug_traceTransaction', [entry.hash, { tracer: 'callTracer' }]),
      priceAt(chain.wrappedNative, tag),
    ]);
    const base = BigInt(block.baseFeePerGas ?? '0x0');
    const gasPrice = BigInt(receipt.effectiveGasPrice);
    const used = BigInt(receipt.gasUsed);
    const { toMiner } = nativeFlows(trace, block.miner, new Set(), '');
    const toBuilderUsd = (Number((gasPrice - base) * used + toMiner) / 1e18) * major;
    const gasUsd = (Number(base * used) / 1e18) * major;
    return { ...entry, toBuilderUsd, gasUsd, keptUsd: entry.grossUsd - toBuilderUsd - gasUsd };
  } catch {
    return null;
  }
});
const traced = paid.filter((entry) => entry !== null);
const tracedGross = sum(traced.map((entry) => entry.grossUsd));
const tracedBuilder = sum(traced.map((entry) => entry.toBuilderUsd));
const tracedKept = sum(traced.map((entry) => entry.keptUsd));

const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(x !== 0 && Math.abs(x) < 10 ? 2 : 0)}`;
console.log(`\n[${chain.name}] ${args.market ?? 'Aave V3'}, ${days} days: ${priced.length} priced of ${logs.length} liquidations`);
console.log(`Collateral minus debt: ${money(grossAll)} total, ${money(grossAll / days)}/day | per liquidation: median ${money(quantile(priced.map((e) => e.grossUsd), 0.5))}, p90 ${money(quantile(priced.map((e) => e.grossUsd), 0.9))}, max ${money(quantile(priced.map((e) => e.grossUsd), 1))}`);
console.log(`Liquidators ${leaders.length}: ${leaders.slice(0, 5).map(([who, v]) => `${who.slice(0, 10)} ${v.count}x ${money(v.grossUsd)}`).join(', ')}`);
console.log(`Largest ${traced.length} traced: gross ${money(tracedGross)}, to builder ${money(tracedBuilder)} (${tracedGross > 0 ? ((tracedBuilder / tracedGross) * 100).toFixed(0) : '-'}%), kept after gas ${money(tracedKept)}`);
console.log('Note: gross ignores the cost of selling collateral, so kept is an upper bound.');

await mkdir('data', { recursive: true });
await writeFile(`data/liquidations-${args.market ?? chain.name}-${new Date().toISOString().replaceAll(':', '-')}.json`, JSON.stringify({ chain: chain.name, days, head, from, grossAll, leaders, traced, priced }, null, 2));
