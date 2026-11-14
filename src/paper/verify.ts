import { readdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { hopsOf, simulateCycle } from '../executor.ts';
import { createPriceReader } from '../prices.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { sum } from '../stats.ts';
import type { SettledTrade } from './engine.ts';
import type { Universe } from './universe.ts';

/**
 * Takes the trades the emulator recorded and executes each one in a real EVM, on the state
 * of the block it was decided on. That state is what the next block starts from, so this
 * shows whether a claimed profit existed at the top of that block.
 */

const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    only: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '4' },
  },
});

const DECIMALS = '0x313ce567';
const chain = CHAINS.ethereum!;
const url = process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain);
const rpc = createRpc(url, 2);
const universe = JSON.parse(await readFile('data/universe-ethereum.json', 'utf8')) as Universe;
const metas = new Map(universe.pools.map((pool) => [pool.address, pool]));
const pricesAt = await createPriceReader();

const files = await readdir('data');
const file = args.file ?? files.filter((f) => /^paper-replay-.*-trades\.jsonl$/.test(f)).sort().at(-1);
if (!file) throw new Error('Нет журнала сделок. Запусти pnpm paper:replay');
const all = (await readFile(`data/${file}`, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as SettledTrade);
const trades = args.only === 'wins' ? all.filter((trade) => trade.results.realistic.outcome === 'won') : all;

const decimals = new Map<string, number>();
const decimalsOf = async (token: string, tag: string): Promise<number> => {
  const known = decimals.get(token);
  if (known !== undefined) return known;
  const value = Number(BigInt(await rpc.call<string>('eth_call', [{ to: token, data: DECIMALS }, tag])));
  decimals.set(token, value);
  return value;
};

const priceOf = (token: string, major: { ETH: number; BTC: number }): number => {
  const asset = chain.tokens[token];
  return asset === 'USD' ? 1 : asset === 'ETH' ? major.ETH : major.BTC;
};

const results = await mapLimit(trades, Number(args.concurrency), async (trade) => {
  const tag = `0x${trade.decidedAtBlock.toString(16)}`;
  const start = trade.route[0]!;
  const hops = hopsOf(trade.route, trade.pools, metas, chain.wrappedNative);
  const simulation = await simulateCycle(rpc, { start, amountIn: BigInt(trade.amountIn), hops, blockTag: tag });
  if (!simulation.ok) return { trade, ok: false, reason: simulation.reason, evmUsd: 0, gasUsed: 0n };
  const header = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [tag, false]);
  const major = await pricesAt(Number(BigInt(header.timestamp)));
  const evmUsd = (Number(simulation.profit) / 10 ** (await decimalsOf(start, tag))) * priceOf(start, major);
  return { trade, ok: true, reason: '', evmUsd, gasUsed: simulation.gasUsed };
});

const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
console.log(`\n=== Проверка в настоящем EVM: ${file} ===`);
for (const { trade, ok, reason, evmUsd, gasUsed } of [...results].sort((a, b) => b.trade.profitUsd - a.trade.profitUsd)) {
  const verdict = ok ? `EVM ${money(evmUsd).padStart(9)} (${((evmUsd / trade.profitUsd) * 100).toFixed(1).padStart(6)}%), газ ${gasUsed}` : `ОТКАТ: ${reason}`;
  console.log(`  блок ${trade.decidedAtBlock} ходов ${trade.pools.length} модель ${money(trade.profitUsd).padStart(9)} реальный мир ${trade.results.realistic.outcome.padEnd(14)} ${verdict}`);
}

const executed = results.filter((entry) => entry.ok);
const modelUsd = sum(executed.map((entry) => entry.trade.profitUsd));
const evmTotal = sum(executed.map((entry) => entry.evmUsd));
console.log(`\nИсполнилось ${executed.length} из ${results.length}. Модель ${money(modelUsd)}, EVM ${money(evmTotal)} (${modelUsd > 0 ? ((evmTotal / modelUsd) * 100).toFixed(1) : '-'}%)`);
const perHop = executed.map((entry) => Number(entry.gasUsed) / entry.trade.pools.length);
if (perHop.length > 0) console.log(`Газ внутри контракта на ход: среднее ${(sum(perHop) / perHop.length).toFixed(0)}`);

await writeFile(
  `data/verify-${file.replace('-trades.jsonl', '.json')}`,
  JSON.stringify(results.map(({ trade, ok, reason, evmUsd, gasUsed }) => ({ block: trade.decidedAtBlock, pools: trade.pools, modelUsd: trade.profitUsd, ok, reason, evmUsd, gasUsed: gasUsed.toString() })), null, 2),
);
