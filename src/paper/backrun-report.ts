import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { createPriceReader } from '../prices.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { sum } from '../stats.ts';
import { settleBackrun, type BackrunAssumptions, type GapPart } from './backrun.ts';
import type { Prices } from './engine.ts';
import { fetchRangeLogs } from './feed.ts';
import { poolKeyOf, SWAP_TOPICS, type PoolLog } from './pools.ts';
import type { PaperSummary } from './report.ts';
import { createRivalLookup } from './rivals.ts';
import { isSandwich, swapZeroForOne, type RouteSwap } from './sandwich.ts';
import type { Visibility } from './streams.ts';

/** Reads the gaps a live run recorded and prices the backrun strategy on them afterwards. */

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    'bid-share': { type: 'string', default: '0.85' },
    'shared-keep': { type: 'string', default: '0.1' },
    infra: { type: 'string', default: '30' },
    top: { type: 'string', default: '8' },
  },
});

interface LoggedPart extends GapPart {
  txHash: string;
}
interface LoggedGap {
  block: number;
  builder: string;
  parts: LoggedPart[];
  route: string[];
  pools: string[];
  usd: number;
  closedSameBlock: boolean;
}

const chain = CHAINS.ethereum!;
const rpc = createRpc(rpcUrlFor(chain));
const logsRpc = createRpc(process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc!, 3);
const traceRpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? chain.defaultTraceRpc!);
const lookup = createRivalLookup(rpc, traceRpc);
const majorPricesAt = await createPriceReader();

const files = await readdir('data');
const gapsFile = args.file ?? files.filter((f) => /^paper-live-.*-gaps\.jsonl$/.test(f)).sort().at(-1);
if (!gapsFile) throw new Error('Нет журнала разрывов. Запусти pnpm paper:live');
const summary = JSON.parse(await readFile(`data/${gapsFile.replace('-gaps.jsonl', '.json')}`, 'utf8')) as PaperSummary;
const gaps = (await readFile(`data/${gapsFile}`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as LoggedGap);

const covered = gaps.filter((gap) => gap.parts.length > 0);
const VISIBLE: Visibility[] = ['mempool', 'mev-share-exact', 'mev-share-topics'];
const reachable = covered.filter((gap) => gap.parts.some((part) => VISIBLE.includes(part.visibility) && part.usd > 0));

const assumptions: BackrunAssumptions = { bidShare: Number(args['bid-share']), sharedKeep: Number(args['shared-keep']), outbidFactor: 1.01 };
const PAYERS_CHECKED = 3;

interface RawBlock {
  timestamp: string;
  transactions: { hash: string; from: string; to: string | null }[];
}

/** Rules out sandwiches, then finds what the next transactions on the route paid. */
async function inspect(gap: LoggedGap): Promise<{ sandwich: boolean; rivalPaidUsd: number }> {
  const [logs, block] = await Promise.all([
    fetchRangeLogs(logsRpc, [...SWAP_TOPICS], gap.block, gap.block),
    rpc.call<RawBlock>('eth_getBlockByNumber', [`0x${gap.block.toString(16)}`, true]),
  ]);
  const senders = new Map(block.transactions.map((tx) => [tx.hash, tx]));
  const onRoute = logs.filter((log: PoolLog) => gap.pools.includes(poolKeyOf(log)));
  const swaps: RouteSwap[] = onRoute.map((log) => {
    const tx = senders.get(log.transactionHash);
    return { txHash: log.transactionHash, pool: poolKeyOf(log), zeroForOne: swapZeroForOne(log), from: tx?.from ?? '', to: tx?.to ?? '' };
  });
  if (isSandwich(gap.parts.map((part) => part.txHash), swaps)) return { sandwich: true, rivalPaidUsd: 0 };

  const order = [...new Set(onRoute.map((log) => log.transactionHash))];
  const lastOpener = Math.max(...gap.parts.map((part) => order.indexOf(part.txHash)));
  const next = order.slice(lastOpener + 1, lastOpener + 1 + PAYERS_CHECKED);
  if (next.length === 0) return { sandwich: false, rivalPaidUsd: 0 };
  const major = await majorPricesAt(Number(BigInt(block.timestamp)));
  const prices: Prices = { usd: new Map(), nativeUsd: major.ETH };
  return { sandwich: false, rivalPaidUsd: await lookup(gap.block, next, prices) };
}

console.error(`${gapsFile}: ${gaps.length} разрывов от $1, из них в учтённых блоках ${covered.length}, с видимой частью ${reachable.length}`);
const inspected = await mapLimit(reachable, 3, async (gap) => ({ gap, ...(await inspect(gap)) }));
const sandwiches = inspected.filter((entry) => entry.sandwich);
const settled = inspected
  .filter((entry) => !entry.sandwich)
  .map(({ gap, rivalPaidUsd }) => ({ gap, rivalPaidUsd, result: settleBackrun(gap.parts, rivalPaidUsd, gap.closedSameBlock, assumptions) }));

const blocksCovered = summary.visibility?.blocksCovered ?? 0;
const hours = (blocksCovered * summary.blockTime) / 3600;
const perDay = hours > 0 ? 24 / hours : 0;
const infraPerDay = Number(args.infra);
const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const total = (pick: (r: (typeof settled)[number]['result']) => number): number => sum(settled.map((s) => pick(s.result)));

const coveredUsd = sum(covered.map((gap) => gap.usd));
const publicUsd = total((r) => r.publicUsd);
const sharedUsd = total((r) => r.sharedUsd);
const possibleUsd = sum(covered.flatMap((gap) => gap.parts.filter((part) => part.visibility === 'mev-share-possible').map((part) => part.usd)));
const share = (x: number): string => (coveredUsd > 0 ? `${((x / coveredUsd) * 100).toFixed(1)}%` : '-');

console.log(`\n=== Торговля за чужой транзакцией, ВИРТУАЛЬНЫЕ деньги ===`);
console.log(`Учтено блоков ${blocksCovered} (${hours.toFixed(1)} ч). Разрывов от $1: ${covered.length} на ${money(coveredUsd)} после газа`);
console.log(`Сэндвич-атаки среди разрывов с видимой частью: ${sandwiches.length} на ${money(sum(sandwiches.map((entry) => entry.gap.usd)))}, исключены: они доступны только самому атакующему`);
console.log(`Видно заранее: мемпул ${money(publicUsd)} (${share(publicUsd)}) | MEV-Share с совпадением ${money(sharedUsd)} (${share(sharedUsd)})`);
console.log(`Не считается: MEV-Share только по пулу ${money(possibleUsd)} (${share(possibleUsd)})`);
for (const [label, value] of [['Мягкий', total((r) => r.soft)], ['Реальный', total((r) => r.real)], ['Лютый', total((r) => r.brutal)]] as const) {
  console.log(`${label.padEnd(9)} итог ${money(value)} | в сутки ${money(value * perDay)} | после инфраструктуры ${money(value * perDay - infraPerDay)}`);
}
console.log(`Цель: $100 в день. Допущения: выплата билдеру ${(assumptions.bidShare * 100).toFixed(0)}%, остаётся от MEV-Share ${(assumptions.sharedKeep * 100).toFixed(0)}%, инфраструктура $${infraPerDay}/день (оценки)`);

const top = [...settled].sort((a, b) => b.result.real - a.result.real || b.gap.usd - a.gap.usd).slice(0, Number(args.top));
if (top.length > 0) console.log('\nКрупнейшие:');
for (const { gap, rivalPaidUsd, result } of top) {
  console.log(`  блок ${gap.block}: разрыв ${money(gap.usd)}, видно ${money(result.publicUsd + result.sharedUsd)}, соперник заплатил ${Number.isFinite(rivalPaidUsd) ? money(rivalPaidUsd) : 'неизвестно'} -> реальный ${money(result.real)}, лютый ${money(result.brutal)}`);
}
