import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chainNamed, CHAINS, rpcUrlFor, type Asset, type Chain } from './chains.ts';
import { detectArb, detectLiquidation, tokensTouched, unwrappedBy, type Log, type Tx } from './detect.ts';
import { createPriceReader, spotUsd } from './prices.ts';
import { createRpc, mapLimit, type Rpc } from './rpc.ts';
import { bootstrapMeanInterval, quantile, sampleWindows, sum } from './stats.ts';

const LATEST_ANSWER = '0x50d25bcd';
const DECIMALS = '0x313ce567';
const SYMBOL = '0x95d89b41';

const { values: args } = parseArgs({
  options: {
    chain: { type: 'string', default: 'base' },
    days: { type: 'string', default: '7' },
    windows: { type: 'string', default: '56' },
    seconds: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '4' },
    seed: { type: 'string', default: '1' },
    // A chain described in a file, as the radar builds one for a market not in the list.
    'chain-file': { type: 'string' },
  },
});

const chain: Chain | undefined = args['chain-file'] ? (JSON.parse(readFileSync(args['chain-file'], 'utf8')) as Chain) : chainNamed(args.chain);
if (!chain) throw new Error(`Unknown chain ${args.chain}. Use: ${Object.keys(CHAINS).join(', ')}`);

const rpc = createRpc(rpcUrlFor(chain));

interface RawTx {
  hash: string;
  value: string;
}
interface RawBlock {
  timestamp: string;
  transactions: RawTx[];
}
interface RawReceipt {
  transactionHash: string;
  transactionIndex: string;
  status: string;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice?: string | null;
  l1Fee?: string | null;
  logs: Log[];
}
interface Hit {
  kind: 'arb' | 'liquidation';
  protocol?: string;
  window: number;
  block: number;
  txIndex: number;
  txCount: number;
  hash: string;
  bot: string;
  swaps: number;
  venues: string[];
  pools: string[];
  tokens: string[];
  usd: number | null;
  unwrappedUsd: number;
  gasUsd: number;
}
interface ContractGas {
  attempts: number;
  reverted: number;
  gasUsd: number;
}
interface WindowResult {
  index: number;
  blocks: number;
  failedBlocks: number;
  txs: number;
  feesUsd: number;
  hits: Hit[];
  gasByContract: Map<string, ContractGas>;
}

const readUint = async (client: Rpc, to: string, data: string, tag: string): Promise<bigint> =>
  BigInt(await client.call<string>('eth_call', [{ to, data }, tag]));

const blockOf = async (client: Rpc, tag: string): Promise<{ number: number; timestamp: number }> => {
  const block = await client.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [tag, false]);
  return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) };
};

const head = await blockOf(rpc, 'latest');
const earlier = await blockOf(rpc, `0x${(head.number - 1000).toString(16)}`);
const blockTime = (head.timestamp - earlier.timestamp) / 1000;
const majorPricesAt = await createPriceReader();

const decimals = new Map<string, number>();
await Promise.all(
  Object.keys(chain.tokens).map(async (token) => {
    try {
      decimals.set(token, Number(await readUint(rpc, token, DECIMALS, 'latest')));
    } catch {
      // Unpriced is safe: a win in this token counts as $0 rather than a wrong amount.
      console.error(`  dropping token ${token}: not readable on ${chain!.name}`);
      delete chain!.tokens[token];
    }
  }),
);
if (Object.keys(chain.tokens).length === 0) throw new Error(`No readable tokens on ${chain.name}`);
const nativeSpotUsd = chain.coingeckoId ? await spotUsd(chain.coingeckoId) : 0;

async function pricesAt(timestamp: number, block: number): Promise<Record<Asset, number>> {
  const { ETH, BTC } = await majorPricesAt(timestamp);
  const bnb = chain!.bnbFeed ? await readUint(rpc, chain!.bnbFeed, LATEST_ANSWER, `0x${block.toString(16)}`) : 0n;
  return { USD: 1, ETH, BTC, BNB: Number(bnb) / 1e8, NATIVE: nativeSpotUsd };
}

const windowCount = Number(args.windows);
const blocksPerWindow = Math.max(1, Math.round(Number(args.seconds) / blockTime));
const spanBlocks = Math.floor((Number(args.days) * 86_400) / blockTime);
const starts = sampleWindows(head.number, spanBlocks, windowCount, blocksPerWindow, Number(args.seed));

console.error(`${chain.name}: ${windowCount} windows x ${blocksPerWindow} blocks over ${args.days}d, block time ${blockTime.toFixed(3)}s`);

let done = 0;
const windows = await mapLimit(starts.map((start, index) => ({ start, index })), Number(args.concurrency), async ({ start, index }) => {
  const result: WindowResult = { index, blocks: 0, failedBlocks: 0, txs: 0, feesUsd: 0, hits: [], gasByContract: new Map() };
  let prices: Record<Asset, number> | undefined;

  for (let number = start; number < start + blocksPerWindow; number++) {
    const tag = `0x${number.toString(16)}`;
    try {
      const [block, receipts] = await Promise.all([
        rpc.call<RawBlock>('eth_getBlockByNumber', [tag, true]),
        rpc.call<RawReceipt[]>('eth_getBlockReceipts', [tag]),
      ]);
      if (!block || !receipts) throw new Error(`Block ${number} not served`);
      prices ??= await pricesAt(Number(BigInt(block.timestamp)), number);
      collectBlock(result, number, block, receipts, prices);
      result.blocks++;
    } catch (err) {
      result.failedBlocks++;
      if (result.failedBlocks === 1) console.error(`  window ${index}: ${(err as Error).message}`);
    }
  }
  if (++done % 10 === 0) console.error(`  ${done}/${windowCount} windows`);
  return result;
});

function collectBlock(result: WindowResult, number: number, block: RawBlock, receipts: RawReceipt[], prices: Record<Asset, number>): void {
  const nativeUsd = prices[chain!.nativeAsset];
  const values = new Map(block.transactions.map((t) => [t.hash, BigInt(t.value)]));

  const tokenUsd = (token: string, amount: bigint): number | null => {
    const asset = chain!.tokens[token];
    return asset === undefined ? null : (Number(amount) / 10 ** decimals.get(token)!) * prices[asset];
  };

  for (const r of receipts) {
    const wei = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0) + BigInt(r.l1Fee ?? 0);
    const gasUsd = (Number(wei) / 1e18) * nativeUsd;
    result.txs++;
    result.feesUsd += gasUsd;

    if (r.to) {
      const to = r.to.toLowerCase();
      const entry = result.gasByContract.get(to) ?? { attempts: 0, reverted: 0, gasUsd: 0 };
      entry.attempts++;
      entry.gasUsd += gasUsd;
      if (r.status !== '0x1') entry.reverted++;
      result.gasByContract.set(to, entry);
    }

    const tx: Tx = {
      hash: r.transactionHash,
      from: r.from,
      to: r.to,
      value: values.get(r.transactionHash) ?? 0n,
      success: r.status === '0x1',
      txIndex: Number(BigInt(r.transactionIndex)),
      logs: r.logs,
    };

    const base = {
      window: result.index,
      block: number,
      txIndex: tx.txIndex,
      txCount: receipts.length,
      hash: tx.hash,
      bot: (tx.to ?? '').toLowerCase(),
      tokens: tokensTouched(tx),
      gasUsd,
      unwrappedUsd: (Number(unwrappedBy(tx, chain!.wrappedNative)) / 1e18) * nativeUsd,
    };

    const liquidation = detectLiquidation(tx);
    if (liquidation) {
      let usd: number | null = tx.value === 0n ? 0 : null;
      for (const [token, net] of liquidation.flows) {
        const value = tokenUsd(token, net < 0n ? -net : net);
        usd = usd === null || value === null ? null : usd + (net < 0n ? -value : value);
      }
      result.hits.push({ ...base, kind: 'liquidation', protocol: liquidation.protocol, swaps: 0, venues: [], pools: [], usd });
      continue;
    }

    const arb = detectArb(tx);
    if (arb) {
      result.hits.push({ ...base, kind: 'arb', swaps: arb.swaps, venues: arb.venues, pools: arb.pools, usd: tokenUsd(arb.token, arb.profit) });
    }
  }
}

const hits = windows.flatMap((w) => w.hits);
const botSet = new Set(hits.map((h) => h.bot));

interface BotStats {
  bot: string;
  wins: number;
  unpricedWins: number;
  attempts: number;
  reverted: number;
  grossUsd: number;
  gasUsd: number;
  pessimisticCostUsd: number;
  bestUsd: number;
  bestTx: string;
  medianWinUsd: number;
}

const hitUsd = (h: Hit): number => h.usd ?? 0;
const hiddenCost = (h: Hit): number => Math.min(h.unwrappedUsd, Math.max(hitUsd(h), 0));

const bots: BotStats[] = [...botSet].map((bot) => {
  const own = hits.filter((h) => h.bot === bot);
  const gas = windows.map((w) => w.gasByContract.get(bot)).filter((g) => g !== undefined);
  const best = own.reduce((a, b) => (hitUsd(b) > hitUsd(a) ? b : a));
  return {
    bot,
    wins: own.length,
    unpricedWins: own.filter((h) => h.usd === null).length,
    attempts: sum(gas.map((g) => g.attempts)),
    reverted: sum(gas.map((g) => g.reverted)),
    grossUsd: sum(own.map(hitUsd)),
    gasUsd: sum(gas.map((g) => g.gasUsd)),
    pessimisticCostUsd: sum(own.map(hiddenCost)),
    bestUsd: hitUsd(best),
    bestTx: best.hash,
    medianWinUsd: quantile(own.filter((h) => h.usd !== null).map(hitUsd), 0.5),
  };
});
bots.sort((a, b) => b.grossUsd - a.grossUsd);

const blocks = sum(windows.map((w) => w.blocks));
const seconds = blocks * blockTime;
const perDay = 86_400 / Math.max(seconds, 1);
const gross = sum(bots.map((b) => b.grossUsd));
const gas = sum(bots.map((b) => b.gasUsd));
const hidden = sum(bots.map((b) => b.pessimisticCostUsd));
const topHit = hits.reduce<Hit | null>((a, b) => (a === null || hitUsd(b) > hitUsd(a) ? b : a), null);

const netByWindow = windows.map((w) => {
  let net = sum(w.hits.map((h) => hitUsd(h) - hiddenCost(h)));
  for (const [contract, entry] of w.gasByContract) if (botSet.has(contract)) net -= entry.gasUsd;
  // Scale to a full-sized window so a partly failed window does not bias the mean.
  return w.blocks > 0 ? (net / w.blocks) * blocksPerWindow : 0;
});
const windowsPerDay = 86_400 / (blocksPerWindow * blockTime);
const [low, high] = bootstrapMeanInterval(netByWindow);

const segment = (kind: Hit['kind']) => {
  const own = hits.filter((h) => h.kind === kind);
  const priced = own.filter((h) => h.usd !== null).map(hitUsd);
  return {
    count: own.length,
    unpriced: own.length - priced.length,
    grossUsd: sum(priced),
    ownGasUsd: sum(own.map((h) => h.gasUsd)),
    perHitUsd: { median: quantile(priced, 0.5), p90: quantile(priced, 0.9), p99: quantile(priced, 0.99), max: quantile(priced, 1) },
  };
};

const shareOfGross = (n: number): number => (gross > 0 ? sum(bots.slice(0, n).map((b) => b.grossUsd)) / gross : 0);

const groupBy = (keyOf: (h: Hit) => string) => {
  const groups = new Map<string, Hit[]>();
  for (const h of hits) groups.set(keyOf(h), [...(groups.get(keyOf(h)) ?? []), h]);
  return [...groups]
    .map(([key, own]) => {
      const byBot = new Map<string, number>();
      for (const h of own) byBot.set(h.bot, (byBot.get(h.bot) ?? 0) + hitUsd(h));
      const total = sum(own.map(hitUsd));
      return {
        key,
        hits: own.length,
        bots: byBot.size,
        grossUsd: total,
        ownGasUsd: sum(own.map((h) => h.gasUsd)),
        topBotShare: total > 0 ? Math.max(...byBot.values()) / total : 0,
      };
    })
    .sort((a, b) => b.grossUsd - a.grossUsd);
};

const repeat = bots.filter((b) => b.wins >= 5);
const symbols = new Map<string, string>();
const symbolOf = async (token: string): Promise<string> => {
  if (symbols.has(token)) return symbols.get(token)!;
  let symbol = token.slice(0, 8);
  try {
    const hex = await rpc.call<string>('eth_call', [{ to: token, data: SYMBOL }, 'latest']);
    const text = Buffer.from(hex.slice(130), 'hex').toString('utf8').replace(/\0/g, '').trim();
    if (text) symbol = text;
  } catch {
    // Non-standard symbol(): keep the address prefix.
  }
  symbols.set(token, symbol);
  return symbol;
};

const nicheTable = groupBy((h) => (h.kind === 'liquidation' ? `liq:${h.protocol}` : h.tokens.join('+'))).slice(0, 15);
for (const niche of nicheTable) {
  if (niche.key.startsWith('liq:')) continue;
  niche.key = (await Promise.all(niche.key.split('+').map(symbolOf))).join('/');
}

const summary = {
  chain: chain.name,
  sampledAt: new Date().toISOString(),
  head: head.number,
  blockTime,
  days: Number(args.days),
  windows: windowCount,
  blocksPerWindow,
  blocks,
  failedBlocks: sum(windows.map((w) => w.failedBlocks)),
  chainMinutes: seconds / 60,
  txs: sum(windows.map((w) => w.txs)),
  feesUsd: sum(windows.map((w) => w.feesUsd)),
  arb: segment('arb'),
  liquidation: segment('liquidation'),
  grossUsd: gross,
  botGasUsd: gas,
  pessimisticHiddenCostUsd: hidden,
  netUsd: gross - gas,
  pessimisticNetUsd: gross - gas - hidden,
  topHit: topHit && { hash: topHit.hash, kind: topHit.kind, usd: hitUsd(topHit), gasUsd: topHit.gasUsd },
  netWithoutTopHitUsd: gross - gas - (topHit ? hitUsd(topHit) - topHit.gasUsd : 0),
  perDay: {
    grossUsd: gross * perDay,
    gasUsd: gas * perDay,
    netUsd: (gross - gas) * perDay,
    pessimisticNetUsd: (gross - gas - hidden) * perDay,
    pessimisticNet90: [low * windowsPerDay, high * windowsPerDay],
  },
  concentration: { contracts: bots.length, top1: shareOfGross(1), top3: shareOfGross(3), top10: shareOfGross(10) },
  repeatBots: {
    count: repeat.length,
    profitable: repeat.filter((b) => b.grossUsd > b.gasUsd + b.pessimisticCostUsd).length,
    grossUsd: sum(repeat.map((b) => b.grossUsd)),
    gasUsd: sum(repeat.map((b) => b.gasUsd)),
    attempts: sum(repeat.map((b) => b.attempts)),
    wins: sum(repeat.map((b) => b.wins)),
  },
  venues: groupBy((h) => (h.kind === 'liquidation' ? `liq:${h.protocol}` : h.venues.join('+'))).slice(0, 12),
  niches: nicheTable,
  bots,
  hits,
};

await mkdir('data', { recursive: true });
const outPath = `data/recon-${chain.name}-${summary.sampledAt.replaceAll(':', '-')}.json`;
await writeFile(outPath, JSON.stringify(summary, null, 2));

const money = (x: number): string => `$${x.toFixed(x !== 0 && Math.abs(x) < 1 ? 4 : 2)}`;
console.log(`\n[${chain.name}] ${blocks} blocks (${(seconds / 60).toFixed(0)} min), ${summary.failedBlocks} failed, ${summary.txs} txs, all fees ${money(summary.feesUsd)}`);
console.log(`Arb ${summary.arb.count} (${summary.arb.unpriced} unpriced) ${money(summary.arb.grossUsd)} | Liquidations ${summary.liquidation.count} (${summary.liquidation.unpriced} unpriced) ${money(summary.liquidation.grossUsd)}`);
console.log(`Gross ${money(gross)} | gas ${money(gas)} | net ${money(gross - gas)} | pessimistic ${money(gross - gas - hidden)} | without top hit ${money(summary.netWithoutTopHitUsd)}`);
console.log(`Per day pessimistic ${money(summary.perDay.pessimisticNetUsd)}, 90% interval ${money(low * windowsPerDay)} to ${money(high * windowsPerDay)}`);
console.log(`Saved ${outPath}`);
