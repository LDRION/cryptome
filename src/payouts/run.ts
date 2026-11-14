import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chainNamed, rpcUrlFor } from '../chains.ts';
import type { Log } from '../detect.ts';
import { createRpc, mapLimit, type Rpc } from '../rpc.ts';
import { quantile, sampleWindows, sum } from '../stats.ts';
import type { CallFrame } from '../trace.ts';
import { bestPrefix, incomeOf, movementsOf, NATIVE, type IncomeKind } from './flows.ts';

/**
 * Maps who the chain pays for calling its public functions. Every block in the span is read; each
 * transaction whose side took tokens in and gave nothing up is a candidate. The biggest groups are then
 * replayed from a fresh empty address on the state just before the original call: a payment that reaches
 * that address is open to anyone. Replays a minute and five minutes earlier show whether the money lay
 * there long enough for a slow caller, which is the whole point: no speed race.
 */

const { values: args } = parseArgs({
  options: {
    chain: { type: 'string', default: 'ethereum' },
    hours: { type: 'string', default: '24' },
    // Below 1, reads that share of the span in random windows instead of every block.
    coverage: { type: 'string', default: '1' },
    'window-minutes': { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '6' },
    rpc: { type: 'string' },
    'max-traces': { type: 'string', default: '1000' },
    samples: { type: 'string', default: '20' },
    'min-group-usd': { type: 'string', default: '3' },
  },
});

const chain = chainNamed(args.chain);
if (!chain) throw new Error(`Unknown chain ${args.chain}`);

const LLAMA: Record<string, string> = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', polygon: 'polygon', avalanche: 'avax',
  gnosis: 'xdai', scroll: 'scroll', linea: 'linea', bsc: 'bsc', mantle: 'mantle', blast: 'blast', celo: 'celo', sonic: 'sonic',
  berachain: 'berachain', zksync: 'era', unichain: 'unichain', hyperliquid: 'hyperliquid', worldchain: 'wc', ink: 'ink', plasma: 'plasma',
};
const llamaChain = LLAMA[chain.name] ?? chain.name;

/** Spreads calls over several free nodes, moving on to the next one when a node gives up. */
function pool(urls: string[]): Rpc {
  const clients = urls.map((url) => createRpc(url, 2, 30_000));
  let next = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const start = next++ % clients.length;
      let last: unknown;
      for (let i = 0; i < clients.length * 2; i++) {
        try {
          return await clients[(start + i) % clients.length]!.call<T>(method, params);
        } catch (err) {
          last = err;
          if ((err as Error).message.includes('execution reverted')) throw err;
        }
      }
      throw last;
    },
  };
}

const urls = args.rpc ? args.rpc.split(',') : [...new Set([rpcUrlFor(chain), chain.defaultLogsRpc, chain.defaultTraceRpc].filter((u): u is string => Boolean(u)))];
const rpc = pool(urls);
const traceUrl = process.env[`TRACE_RPC_URL_${chain.name.toUpperCase()}`];
const traceRpc = traceUrl ? createRpc(traceUrl, 3, 60_000) : null;
const hex = (n: number | bigint): string => `0x${n.toString(16)}`;

interface RawTx {
  hash: string;
  value: string;
  input: string;
}
interface RawReceipt {
  transactionHash: string;
  status: string;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice?: string | null;
  l1Fee?: string | null;
  logs: Log[];
}
interface Candidate {
  block: number;
  hash: string;
  from: string;
  to: string;
  kind: IncomeKind;
  payer: string;
  selector: string;
  input: string;
  net: [string, string][];
  gasWei: string;
  gasPrice: string;
  l1FeeWei: string;
}
interface TargetStats {
  attempts: number;
  reverted: number;
  senders: Set<string>;
}

const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
const blockTimeOf = async (n: number): Promise<number> => Number(BigInt((await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex(n), false])).timestamp));
const blockTime = ((await blockTimeOf(head)) - (await blockTimeOf(head - 1000))) / 1000;
const spanBlocks = Math.floor((Number(args.hours) * 3600) / blockTime);
const coverage = Number(args.coverage);

let blocks: number[];
if (coverage >= 1) {
  blocks = Array.from({ length: spanBlocks }, (_, i) => head - spanBlocks + 1 + i);
} else {
  const perWindow = Math.max(1, Math.round((Number(args['window-minutes']) * 60) / blockTime));
  const windows = Math.max(1, Math.round((spanBlocks * coverage) / perWindow));
  blocks = sampleWindows(head, spanBlocks, windows, perWindow, 7).flatMap((start) => Array.from({ length: perWindow }, (_, i) => start + i));
}
console.error(`${chain.name}: ${blocks.length} blocks of ${spanBlocks} over ${args.hours}h, block ${blockTime.toFixed(2)}s, nodes ${urls.map((u) => new URL(u).host).join(', ')}`);

const candidates: Candidate[] = [];
const targets = new Map<string, TargetStats>();
let scanned = 0;
let failed = 0;
let txCount = 0;
const started = Date.now();

await mapLimit(blocks, Number(args.concurrency), async (number) => {
  try {
    const [block, receipts] = await Promise.all([
      rpc.call<{ transactions: RawTx[] }>('eth_getBlockByNumber', [hex(number), true]),
      rpc.call<RawReceipt[]>('eth_getBlockReceipts', [hex(number)]),
    ]);
    const txs = new Map(block.transactions.map((t) => [t.hash, t]));
    for (const r of receipts) {
      txCount++;
      if (!r.to) continue;
      const to = r.to.toLowerCase();
      const from = r.from.toLowerCase();
      const stats = targets.get(to) ?? { attempts: 0, reverted: 0, senders: new Set<string>() };
      stats.attempts++;
      if (r.status !== '0x1') stats.reverted++;
      if (stats.senders.size < 50) stats.senders.add(from);
      targets.set(to, stats);
      if (r.status !== '0x1') continue;

      const tx = txs.get(r.transactionHash);
      if (!tx) continue;
      const income = incomeOf(movementsOf(r.logs), from, to, BigInt(tx.value));
      if (!income) continue;
      const gasPrice = BigInt(r.effectiveGasPrice ?? 0);
      const l1Fee = BigInt(r.l1Fee ?? 0);
      candidates.push({
        block: number,
        hash: r.transactionHash,
        from,
        to,
        kind: income.kind,
        payer: income.payer,
        selector: tx.input.slice(0, 10),
        input: tx.input,
        net: [...income.net].map(([token, amount]) => [token, amount.toString()]),
        gasWei: (BigInt(r.gasUsed) * gasPrice + l1Fee).toString(),
        gasPrice: gasPrice.toString(),
        l1FeeWei: l1Fee.toString(),
      });
    }
    scanned++;
  } catch (err) {
    if (++failed <= 5) console.error(`  block ${number}: ${(err as Error).message.slice(0, 160)}`);
  }
  const done = scanned + failed;
  if (done % 500 === 0) console.error(`  ${done}/${blocks.length} blocks, ${candidates.length} candidates, ${((Date.now() - started) / 60_000).toFixed(1)} min`);
});

// Prices: DefiLlama's current price, kept only when it is confident about it.
interface Price {
  price: number;
  decimals: number;
  symbol: string;
}
const prices = new Map<string, Price>();
async function priceTokens(tokens: string[]): Promise<void> {
  const missing = [...new Set(tokens)].filter((t) => !prices.has(t));
  for (let i = 0; i < missing.length; i += 60) {
    const batch = missing.slice(i, i + 60);
    const keys = batch.map((t) => (t === NATIVE ? `${llamaChain}:${chain!.wrappedNative}` : `${llamaChain}:${t}`));
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(',')}`, { signal: AbortSignal.timeout(30_000) });
        const coins = ((await res.json()) as { coins: Record<string, { price: number; decimals?: number; symbol: string; confidence?: number }> }).coins;
        batch.forEach((token, j) => {
          const coin = coins[keys[j]!];
          if (coin && coin.price > 0 && (coin.confidence ?? 1) >= 0.9) prices.set(token, { price: coin.price, decimals: coin.decimals ?? 18, symbol: coin.symbol });
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      }
    }
  }
}
await priceTokens([NATIVE, ...candidates.flatMap((c) => c.net.map(([token]) => token))]);
const nativeUsd = prices.get(NATIVE)?.price;
if (!nativeUsd) throw new Error('No native price from DefiLlama');

const usdOf = (token: string, amount: bigint): number | null => {
  const p = prices.get(token);
  return p ? (Number(amount) / 10 ** p.decimals) * p.price : null;
};
const gainUsd = (received: Iterable<[string, bigint]>): { usd: number; unpriced: number } => {
  let usd = 0;
  let unpriced = 0;
  for (const [token, amount] of received) {
    const value = usdOf(token, amount);
    if (value === null) unpriced++;
    else usd += value;
  }
  return { usd, unpriced };
};
const weiUsd = (wei: bigint): number => (Number(wei) / 1e18) * nativeUsd;

interface Payout extends Candidate {
  gainUsd: number;
  gasUsd: number;
}
const payouts: Payout[] = [];
const unpricedTokens = new Map<string, number>();
for (const c of candidates) {
  const { usd, unpriced } = gainUsd(c.net.map(([t, a]) => [t, BigInt(a)]));
  if (unpriced > 0) for (const [t] of c.net) if (!prices.has(t)) unpricedTokens.set(t, (unpricedTokens.get(t) ?? 0) + 1);
  if (usd > 0) payouts.push({ ...c, gainUsd: usd, gasUsd: weiUsd(BigInt(c.gasWei)) });
}

const perDay = 86_400 / Math.max(1, scanned * blockTime);
const keyOf = (p: Payout): string => (p.kind === 'direct' ? `${p.to}:${p.selector}` : `via:${p.payer}`);
const grouped = new Map<string, Payout[]>();
for (const p of payouts) grouped.set(keyOf(p), [...(grouped.get(keyOf(p)) ?? []), p]);

// Replays.
const fake = `0x${randomBytes(20).toString('hex')}`;
interface SimCall {
  from: string;
  to: string;
  data: string;
  value: string;
}
interface SimResult {
  gainUsd: number;
  gasUsed: bigint;
  /** How many of the calls, from the first, to make to keep that gain. */
  calls: number;
}
async function simulate(calls: SimCall[], tag: string): Promise<SimResult> {
  const result = await rpc.call<{ calls: { status: string; gasUsed: string; logs?: Log[] }[] }[]>('eth_simulateV1', [
    { blockStateCalls: [{ stateOverrides: { [fake]: { balance: hex(10n ** 21n) } }, calls }], traceTransfers: true, validation: false },
    tag,
  ]);
  const made = result[0]!.calls;
  const perCall = made.map((c) => (c.status === '0x1' ? (c.logs ?? []) : null));
  await priceTokens(movementsOf(perCall.flatMap((logs) => logs ?? [])).map((m) => m.token));
  const best = bestPrefix(perCall, fake, (net) => gainUsd(net).usd);
  const gasUsed = made.slice(0, best.calls).reduce((a, c) => a + (c.status === '0x1' ? BigInt(c.gasUsed) : 0n), 0n);
  return { gainUsd: best.usd, gasUsed, calls: best.calls };
}

/** The calls the bot's own contract made, to be made again by the empty address itself. */
async function innerCalls(p: Payout): Promise<SimCall[] | null> {
  if (!traceRpc) return null;
  try {
    const root = await traceRpc.call<CallFrame & { input?: string }>('debug_traceTransaction', [p.hash, { tracer: 'callTracer' }]);
    const children = (root.calls ?? []).filter((c) => !c.error && c.to && (c.type ?? 'CALL').toUpperCase() === 'CALL') as (CallFrame & { input?: string })[];
    if (children.length === 0 || children.length > 12) return null;
    return children.map((c) => ({ from: fake, to: c.to!, data: c.input ?? '0x', value: c.value ?? '0x0' }));
  } catch {
    return null;
  }
}

interface Replay {
  hash: string;
  block: number;
  gainUsd: number;
  via: 'direct' | 'inner' | null;
  simGainUsd: number;
  ourGasUsd: number;
  /** What the empty address would have got this many minutes before the original call. */
  lag1: number | null;
  lag5: number | null;
}

const lagBlocks = (minutes: number): number => Math.max(1, Math.round((minutes * 60) / blockTime));

interface Opening {
  calls: SimCall[];
  via: 'direct' | 'inner';
  simGainUsd: number;
  ourGasUsd: number;
}
let traces = 0;
const maxTraces = Number(args['max-traces']);

/** Whether the empty address, making the same call on the state just before it, would be paid too. */
async function tryOpen(p: Payout, allowTrace: boolean, budgeted = true): Promise<Opening | null> {
  const tag = hex(p.block - 1);
  const judge = async (calls: SimCall[], via: Opening['via']): Promise<Opening | null> => {
    const sim = await simulate(calls, tag);
    if (sim.gainUsd < p.gainUsd * 0.5) return null;
    return { calls: calls.slice(0, sim.calls), via, simGainUsd: sim.gainUsd, ourGasUsd: weiUsd(sim.gasUsed * BigInt(p.gasPrice) + BigInt(p.l1FeeWei)) };
  };
  if (p.kind === 'direct' && p.to !== p.from) {
    const found = await judge([{ from: fake, to: p.to, data: p.input, value: '0x0' }], 'direct');
    if (found) return found;
  }
  if (!allowTrace || (budgeted && traces >= maxTraces)) return null;
  if (budgeted) traces++;
  const inner = await innerCalls(p);
  return inner ? judge(inner, 'inner') : null;
}

const ranked = [...grouped]
  .map(([key, list]) => ({ key, list, usdPerDay: sum(list.map((p) => p.gainUsd)) * perDay }))
  .filter((g) => g.usdPerDay >= Number(args['min-group-usd']))
  .sort((a, b) => b.usdPerDay - a.usdPerDay);
// A bot's own contract is called by its owner alone, so only targets with few senders are worth a trace.
// Moving one's own funds pays thousands of times its gas, a reward for a call rarely does.
const traceable = (p: Payout): boolean => (p.kind === 'contract' || (targets.get(p.to)?.senders.size ?? 0) <= 3) && p.gainUsd < p.gasUsd * 20_000;
console.error(`${payouts.length} priced payouts in ${grouped.size} groups; screening ${ranked.length} worth $${args['min-group-usd']}+/day`);

const replays = new Map<string, Replay[]>();
const opened = new Map<string, Opening['via']>();
let screened = 0;
await mapLimit(ranked, Number(args.concurrency), async (group) => {
  const bySize = [...group.list].sort((a, b) => b.gainUsd - a.gainUsd);
  const representatives = [...new Set([bySize[0]!, bySize[Math.floor(bySize.length / 2)]!])];
  for (const p of representatives) {
    try {
      const found = await tryOpen(p, traceable(p));
      if (found) {
        opened.set(group.key, found.via);
        break;
      }
    } catch (err) {
      console.error(`  screen ${p.hash.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  if (++screened % 200 === 0) console.error(`  screened ${screened}/${ranked.length}, open ${opened.size}, traces ${traces}`);
});
console.error(`open groups: ${opened.size}; measuring how long their money lay there`);

await mapLimit(
  ranked.filter((g) => opened.has(g.key)),
  3,
  async (group) => {
    const byBlock = group.list.map((p) => p.block).sort((a, b) => a - b);
    const out: Replay[] = [];
    for (const p of [...group.list].sort((a, b) => b.gainUsd - a.gainUsd).slice(0, Number(args.samples))) {
      const replay: Replay = { hash: p.hash, block: p.block, gainUsd: p.gainUsd, via: null, simGainUsd: 0, ourGasUsd: 0, lag1: null, lag5: null };
      try {
        // The trace budget is for screening; a group known to be open is always measured in full.
        const found = await tryOpen(p, opened.get(group.key) === 'inner', false);
        if (found) {
          Object.assign(replay, { via: found.via, simGainUsd: found.simGainUsd, ourGasUsd: found.ourGasUsd });
          const previous = byBlock.filter((b) => b < p.block).at(-1) ?? -Infinity;
          for (const [minutes, field] of [[1, 'lag1'], [5, 'lag5']] as const) {
            const at = p.block - 1 - lagBlocks(minutes);
            // Earlier than the last payout of this group the reward would be counted twice.
            if (at <= previous) continue;
            replay[field] = (await simulate(found.calls, hex(at))).gainUsd;
          }
        }
      } catch (err) {
        console.error(`  replay ${p.hash.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`);
      }
      out.push(replay);
    }
    replays.set(group.key, out);
  },
);

// Names, so the table can be read without an explorer.
const names = new Map<string, string>();
async function contractName(address: string): Promise<string> {
  try {
    const raw = await rpc.call<string>('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']);
    const text = Buffer.from(raw.slice(130), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').trim();
    return text.slice(0, 40);
  } catch {
    return '';
  }
}
const signatures = new Map<string, string>();
async function lookupSignatures(selectors: string[]): Promise<void> {
  for (const selector of new Set(selectors)) {
    try {
      const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, { signal: AbortSignal.timeout(15_000) });
      const results = ((await res.json()) as { results?: { text_signature: string; id: number }[] }).results ?? [];
      const oldest = results.sort((a, b) => a.id - b.id)[0];
      if (oldest) signatures.set(selector, oldest.text_signature);
    } catch {
      // A missing name only makes the table harder to read.
    }
  }
}

const report = ranked.map((group) => {
  const list = group.list;
  const reps = replays.get(group.key) ?? [];
  const open = reps.filter((r) => r.via !== null);
  const sampledUsd = sum(reps.map((r) => r.gainUsd));
  const openShare = sampledUsd > 0 ? sum(open.map((r) => r.gainUsd)) / sampledUsd : 0;
  const slow = open.filter((r) => r.lag1 !== null && r.lag1 > r.ourGasUsd);
  // What a caller a minute ahead of the one who took it would have kept, scaled from the samples by value.
  const captureShare = sampledUsd > 0 ? sum(slow.map((r) => r.lag1! - r.ourGasUsd)) / sampledUsd : 0;
  const callers = new Map<string, number>();
  for (const p of list) callers.set(p.from, (callers.get(p.from) ?? 0) + p.gainUsd);
  const total = sum(list.map((p) => p.gainUsd));
  const stats = targets.get(list[0]!.to);
  const blocksSorted = list.map((p) => p.block).sort((a, b) => a - b);
  const gaps = blocksSorted.slice(1).map((b, i) => ((b - blocksSorted[i]!) * blockTime) / 60);
  return {
    key: group.key,
    kind: list[0]!.kind,
    to: list[0]!.to,
    payer: list[0]!.payer,
    selector: list[0]!.selector,
    payoutsPerDay: list.length * perDay,
    usdPerDay: group.usdPerDay,
    gasUsdPerDay: sum(list.map((p) => p.gasUsd)) * perDay,
    medianPayoutUsd: quantile(list.map((p) => p.gainUsd), 0.5),
    medianRewardToGas: quantile(list.map((p) => p.gainUsd / Math.max(p.gasUsd, 1e-9)), 0.5),
    medianGapMinutes: quantile(gaps, 0.5),
    callers: callers.size,
    topCallerShare: total > 0 ? Math.max(...callers.values()) / total : 0,
    targetSenders: stats ? stats.senders.size : 0,
    targetRevertsPerDay: stats ? stats.reverted * perDay : 0,
    replayed: reps.length,
    open: open.length,
    openShare,
    openUsdPerDay: group.usdPerDay * openShare,
    slow: slow.length,
    captureUsdPerDay: group.usdPerDay * captureShare,
    replays: reps,
  };
});

const shown = report.filter((g) => g.open > 0);
await Promise.all(shown.map(async (g) => names.set(g.to, await contractName(g.to))));
await lookupSignatures(shown.map((g) => g.selector));

const openUsd = sum(report.map((g) => g.openUsdPerDay));
const captureUsd = sum(report.map((g) => g.captureUsdPerDay));
// The rule the radar uses too: a figure that stands only on its two biggest hits is not income.
const biggest = report
  .flatMap((g) => g.replays.filter((r) => r.lag1 !== null && r.lag1 > r.ourGasUsd).map((r) => (r.lag1! - r.ourGasUsd) * perDay))
  .sort((a, b) => b - a)
  .slice(0, 2);
const captureWithoutTop2 = Math.max(0, captureUsd - sum(biggest));

const summary = {
  chain: chain.name,
  sampledAt: new Date().toISOString(),
  head,
  blockTime,
  hours: Number(args.hours),
  blocksScanned: scanned,
  blocksFailed: failed,
  txs: txCount,
  candidates: candidates.length,
  pricedPayouts: payouts.length,
  allPayoutsUsdPerDay: sum(payouts.map((p) => p.gainUsd)) * perDay,
  groups: grouped.size,
  replayedGroups: ranked.length,
  openUsdPerDay: openUsd,
  captureUsdPerDay: captureUsd,
  captureWithoutTop2UsdPerDay: captureWithoutTop2,
  traced: Boolean(traceRpc),
  topUnpriced: [...unpricedTokens].sort((a, b) => b[1] - a[1]).slice(0, 20),
  report: report.map((g) => ({ ...g, name: names.get(g.to) ?? '', signature: signatures.get(g.selector) ?? '' })),
};
await mkdir('data/payouts', { recursive: true });
const outPath = `data/payouts/${chain.name}-${summary.sampledAt.replaceAll(':', '-')}.json`;
await writeFile(outPath, JSON.stringify(summary, null, 2));

const money = (x: number): string => `$${x.toFixed(Math.abs(x) < 10 ? 2 : 0)}`;
console.log(`\n[${chain.name}] ${scanned} blocks (${((scanned * blockTime) / 3600).toFixed(1)} h), ${failed} failed, ${txCount} txs`);
console.log(`Payouts to callers: ${payouts.length} priced, ${money(summary.allPayoutsUsdPerDay)}/day in ${grouped.size} groups (includes people claiming their own)`);
console.log(`Open to anyone (replayed from an empty address): ${money(openUsd)}/day`);
console.log(`Takeable a minute early, after our gas: ${money(captureUsd)}/day, without the two biggest ${money(captureWithoutTop2)}/day`);
console.log('\nOpen groups, by money a minute-early caller would keep:');
for (const g of shown.sort((a, b) => b.captureUsdPerDay - a.captureUsdPerDay).slice(0, 25)) {
  const label = `${names.get(g.to) || g.to.slice(0, 10)} ${signatures.get(g.selector) || g.selector}`.slice(0, 48).padEnd(48);
  console.log(
    `${label} ${money(g.usdPerDay).padStart(7)}/d open ${g.open}/${g.replayed} slow ${g.slow} keep ${money(g.captureUsdPerDay).padStart(6)}/d | ${g.payoutsPerDay.toFixed(0)}/d, ${g.callers} callers, top ${(g.topCallerShare * 100).toFixed(0)}%, reward/gas ${g.medianRewardToGas.toFixed(1)}, gap ${g.medianGapMinutes.toFixed(0)} min`,
  );
}
console.log(`\nSaved ${outPath}`);
