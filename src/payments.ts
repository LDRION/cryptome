import { readdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chainNamed, rpcUrlFor } from './chains.ts';
import { detectArb, tokenNet, type Log, type Tx } from './detect.ts';
import { createPriceReader, spotUsd } from './prices.ts';
import { createRpc, mapLimit } from './rpc.ts';
import { bootstrapMeanInterval, quantile, sum } from './stats.ts';
import { nativeFlows, realProfit, type CallFrame } from './trace.ts';

const LATEST_ANSWER = '0x50d25bcd';

const { values: args } = parseArgs({
  options: {
    chain: { type: 'string', default: 'ethereum' },
    file: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    'trace-rpc': { type: 'string' },
    // Some nodes keep single-transaction traces only for minutes but can trace any recent block.
    'by-block': { type: 'boolean', default: false },
  },
});

const chain = chainNamed(args.chain);
if (!chain) throw new Error(`Unknown chain ${args.chain}`);
const traceUrl = args['trace-rpc'] ?? process.env[`TRACE_RPC_URL_${chain.name.toUpperCase()}`] ?? chain.defaultTraceRpc;
if (!traceUrl) throw new Error(`No trace endpoint for ${chain.name}`);

const rpc = createRpc(rpcUrlFor(chain));
const traceRpc = createRpc(traceUrl);

const blockTraces = new Map<number, Promise<{ result: CallFrame }[]>>();
const traceInBlock = (block: number): Promise<{ result: CallFrame }[]> => {
  let traces = blockTraces.get(block);
  if (!traces) {
    traces = traceRpc.call<{ result: CallFrame }[]>('debug_traceBlockByNumber', [`0x${block.toString(16)}`, { tracer: 'callTracer' }]);
    blockTraces.set(block, traces);
  }
  return traces;
};

const file = args.file ?? (await readdir('data')).filter((f) => f.startsWith(`recon-${chain.name}-`)).sort().at(-1);
if (!file) throw new Error(`No recon data for ${chain.name}`);

interface Hit {
  kind: 'arb' | 'liquidation';
  window: number;
  block: number;
  hash: string;
  bot: string;
  usd: number | null;
  gasUsd: number;
}
interface RawReceipt {
  transactionHash: string;
  transactionIndex: string;
  status: string;
  from: string;
  to: string | null;
  logs: Log[];
}
const recon = JSON.parse(await readFile(`data/${file}`, 'utf8')) as {
  hits: Hit[];
  botGasUsd: number;
  windows: number;
  blocksPerWindow: number;
  blockTime: number;
  chainMinutes: number;
};

const majorPricesAt = await createPriceReader();
const nativeSpot = chain.coingeckoId ? await spotUsd(chain.coingeckoId) : null;
const blockCache = new Map<number, Promise<{ miner: string; nativeUsd: number }>>();
const blockInfo = (number: number) => {
  let info = blockCache.get(number);
  if (!info) {
    info = (async () => {
      const tag = `0x${number.toString(16)}`;
      const block = await rpc.call<{ miner: string; timestamp: string }>('eth_getBlockByNumber', [tag, false]);
      const nativeUsd = chain!.bnbFeed
        ? // Public nodes refuse old state. Today's price is close enough for a measure over hours.
          await rpc.call<string>('eth_call', [{ to: chain!.bnbFeed, data: LATEST_ANSWER }, tag]).then((raw) => Number(BigInt(raw)) / 1e8, () => spotUsd('binancecoin'))
        : chain!.nativeAsset === 'USD'
          ? 1
          : (nativeSpot ?? (await majorPricesAt(Number(BigInt(block.timestamp)))).ETH);
      return { miner: block.miner, nativeUsd };
    })();
    blockCache.set(number, info);
  }
  return info;
};

const empty = (hit: Hit) => ({
  hash: hit.hash,
  window: hit.window,
  bot: hit.bot,
  miner: '',
  detectedUsd: hit.usd ?? 0,
  gasUsd: hit.gasUsd,
  grossUsd: 0,
  minerUsd: 0,
  retainedUsd: 0,
  legs: [] as { counterparty: string; usd: number }[],
  failed: false,
  excluded: false,
});

const arbs =recon.hits.filter((h) => h.kind === 'arb' && h.usd !== null);
console.error(`${chain.name}: tracing ${arbs.length} priced arbs from ${file} via ${new URL(traceUrl).host}`);

let done = 0;
const traced = await mapLimit(arbs, Number(args.concurrency), async (hit) => {
  try {
    const [info, receipt, sent] = await Promise.all([
      blockInfo(hit.block),
      rpc.call<RawReceipt>('eth_getTransactionReceipt', [hit.hash]),
      rpc.call<{ value: string }>('eth_getTransactionByHash', [hit.hash]),
    ]);
    const trace = args['by-block']
      ? (await traceInBlock(hit.block))[Number(BigInt(receipt.transactionIndex))]?.result
      : await traceRpc.call<CallFrame>('debug_traceTransaction', [hit.hash, { tracer: 'callTracer' }]);
    if (!trace) throw new Error('no trace in block');
    const tx: Tx = {
      hash: hit.hash,
      from: receipt.from,
      to: receipt.to,
      value: BigInt(sent.value),
      success: receipt.status === '0x1',
      txIndex: Number(BigInt(receipt.transactionIndex)),
      logs: receipt.logs,
    };
    const arb = detectArb(tx);
    if (arb === null) return { ...empty(hit), excluded: true };
    const entity = new Set([receipt.from.toLowerCase(), hit.bot]);
    const flows = nativeFlows(trace, info.miner, entity, chain!.wrappedNative);
    const legs = [...flows.byCounterparty];
    const legsNet = legs.reduce((total, [, amount]) => total + amount, 0n);

    const real = realProfit({
      hitUsd: hit.usd ?? 0,
      gainIsWrapped: arb.token === chain!.wrappedNative,
      wrappedNet: tokenNet(tx, chain!.wrappedNative),
      legsNet,
      toMiner: flows.toMiner,
      nativeUsd: info.nativeUsd,
      gasUsd: hit.gasUsd,
    });
    if (++done % 50 === 0) console.error(`  ${done}/${arbs.length}`);
    const toUsd = (wei: bigint): number => (Number(wei) / 1e18) * info.nativeUsd;
    return {
      ...empty(hit),
      miner: info.miner,
      ...real,
      legs: legs.map(([counterparty, amount]) => ({ counterparty, usd: toUsd(amount) })),
    };
  } catch (err) {
    console.error(`  ${hit.hash}: ${(err as Error).message}`);
    return { ...empty(hit), failed: true };
  }
});

const ok = traced.filter((t) => !t.failed && !t.excluded);
const gross = sum(ok.map((t) => t.grossUsd));
const toMiner = sum(ok.map((t) => t.minerUsd));
const gas = sum(ok.map((t) => t.gasUsd));
const retained = gross - toMiner - gas;
// Scale by what was actually traced, so a partial run does not read as a quiet market.
const failedCount = traced.filter((t) => t.failed).length;
const coverage = (traced.length - failedCount) / Math.max(traced.length, 1);
const minutes = recon.chainMinutes * coverage;
// Probes and losing attempts by the same contracts are a real cost of the wins above.
const attemptGas = Math.max(recon.botGasUsd - gas, 0) * coverage;

const byBot = new Map<string, typeof ok>();
for (const t of ok) byBot.set(t.bot, [...(byBot.get(t.bot) ?? []), t]);
const bots = [...byBot]
  .map(([bot, own]) => ({
    bot,
    wins: own.length,
    grossUsd: sum(own.map((t) => t.grossUsd)),
    minerUsd: sum(own.map((t) => t.minerUsd)),
    gasUsd: sum(own.map((t) => t.gasUsd)),
    retainedUsd: sum(own.map((t) => t.retainedUsd)),
  }))
  .sort((a, b) => b.retainedUsd - a.retainedUsd);

const legTotals = new Map<string, { hits: number; usd: number }>();
for (const t of ok) {
  for (const leg of t.legs) {
    const entry = legTotals.get(leg.counterparty) ?? { hits: 0, usd: 0 };
    entry.hits++;
    entry.usd += leg.usd;
    legTotals.set(leg.counterparty, entry);
  }
}

const retainedByWindow = Array.from({ length: recon.windows }, () => 0);
for (const t of ok) retainedByWindow[t.window]! += t.retainedUsd;
const [low, high] = bootstrapMeanInterval(retainedByWindow);
const windowsPerDay = 86_400 / (recon.blocksPerWindow * recon.blockTime);

const positive = ok.filter((t) => t.grossUsd > 0);
const shares = positive.map((t) => t.minerUsd / t.grossUsd);
const retainedValues = ok.map((t) => t.retainedUsd);
const sortedRetained = [...retainedValues].sort((a, b) => b - a);

const summary = {
  chain: chain.name,
  source: file,
  traced: ok.length,
  failed: failedCount,
  excluded: traced.filter((t) => t.excluded).length,
  chainMinutes: recon.chainMinutes,
  detectedUsd: sum(ok.map((t) => t.detectedUsd)),
  grossUsd: gross,
  minerUsd: toMiner,
  gasUsd: gas,
  retainedUsd: retained,
  attemptGasUsd: attemptGas,
  netAfterAttemptsUsd: retained - attemptGas,
  netAfterAttemptsPerDay: ((retained - attemptGas) / Math.max(minutes, 1)) * 1440,
  minerShareOfGross: gross > 0 ? toMiner / gross : 0,
  minerSharePerHit: { median: quantile(shares, 0.5), p10: quantile(shares, 0.1), p90: quantile(shares, 0.9) },
  retainedPerHit: { median: quantile(retainedValues, 0.5), p90: quantile(retainedValues, 0.9), max: quantile(retainedValues, 1) },
  losingHits: ok.filter((t) => t.retainedUsd < 0).length,
  topHitRetainedShare: retained > 0 ? (sortedRetained[0] ?? 0) / retained : 0,
  retainedWithoutTopHit: retained - (sortedRetained[0] ?? 0),
  retainedPerDay: (retained / Math.max(minutes, 1)) * 1440,
  retainedPerDay90: [low * windowsPerDay, high * windowsPerDay],
  botsProfitable: bots.filter((b) => b.retainedUsd > 0).length,
  botsTotal: bots.length,
  topBotShareOfRetained: retained > 0 ? (bots[0]?.retainedUsd ?? 0) / retained : 0,
  bots,
  legs: [...legTotals].map(([counterparty, v]) => ({ counterparty, ...v })).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 15),
  hits: traced,
};

const outPath = `data/${file.replace('recon-', 'payments-')}`;
await writeFile(outPath, JSON.stringify(summary, null, 2));

const money = (x: number): string => `$${x.toFixed(x !== 0 && Math.abs(x) < 1 ? 4 : 2)}`;
console.log(`\n[${chain.name}] traced ${ok.length}, failed ${summary.failed}, excluded ${summary.excluded}, ${recon.chainMinutes.toFixed(0)} min of chain time`);
console.log(`Detected ${money(summary.detectedUsd)} -> real gross ${money(gross)} | to miner ${money(toMiner)} (${(summary.minerShareOfGross * 100).toFixed(1)}%) | gas ${money(gas)} | retained ${money(retained)}`);
console.log(`Other attempts' gas ${money(attemptGas)} | net after attempts ${money(summary.netAfterAttemptsUsd)} = ${money(summary.netAfterAttemptsPerDay)}/day`);
console.log(`Miner share per hit: median ${(summary.minerSharePerHit.median * 100).toFixed(1)}%, p10 ${(summary.minerSharePerHit.p10 * 100).toFixed(1)}%, p90 ${(summary.minerSharePerHit.p90 * 100).toFixed(1)}%`);
console.log(`Retained per hit: median ${money(summary.retainedPerHit.median)}, p90 ${money(summary.retainedPerHit.p90)}, max ${money(summary.retainedPerHit.max)} | losing hits ${summary.losingHits} | without top hit ${money(summary.retainedWithoutTopHit)}`);
console.log(`Retained per day ${money(summary.retainedPerDay)}, 90% interval ${money(summary.retainedPerDay90[0]!)} to ${money(summary.retainedPerDay90[1]!)} | profitable bots ${summary.botsProfitable}/${summary.botsTotal}`);
console.table(bots.slice(0, 8).map((b) => ({ bot: b.bot.slice(0, 12), wins: b.wins, gross: Math.round(b.grossUsd), miner: Math.round(b.minerUsd), gas: +b.gasUsd.toFixed(2), retained: Math.round(b.retainedUsd) })));
console.table(summary.legs.slice(0, 6).map((l) => ({ counterparty: l.counterparty, hits: l.hits, usd: Math.round(l.usd) })));
console.log(`Saved ${outPath}`);
