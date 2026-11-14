import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { blockKind, type BlockKind } from '../paper/proposers.ts';
import { createRpc, mapLimit } from '../rpc.ts';

/**
 * A month in seconds, from what really happened rather than from the emulator's verdicts.
 *
 * Part one runs every recorded block under several sending rules. What a public attempt costs and
 * how often it wins come from our real attempts: on 51 of them the emulator's optimistic verdict
 * promised $479 and reality gave -$1.56, so its verdicts are not used. Only facts from the chain are:
 * who built the block, whether anyone closed our gap, and what they paid the builder.
 *
 * Part one sees only ordinary trades. Places behind someone's pending transaction are not in the
 * trade records, and they gave 3 of our 4 real wins, so the public side of part one runs low.
 *
 * Part two builds months out of real shots alone: how often a nearly sure slot got an attempt, and
 * what attempts at self-built blocks really brought. It covers every kind of attempt.
 *
 * Months are made by drawing recorded hours at random, so one lucky hour would come back many times.
 * The two best blocks of each rule are therefore shown apart and left out of its figures: once they
 * were a WBTC/USDT "gap" of $107 that stayed open two blocks running because nobody could take it.
 */

const { values: args } = parseArgs({
  options: {
    land: { type: 'string', default: '0.3' },
    runs: { type: 'string', default: '10000' },
    days: { type: 'string', default: '30' },
  },
});

interface Trade {
  targetBlock: number;
  pools: string[];
  profitUsd: number;
  gasUnits: string;
  gasUsd: number;
  rivalPaymentUsd: number;
  closedByTxs?: string[];
  builder?: string;
}
interface KindRow {
  block: number;
  kind: BlockKind;
  predicted: boolean;
  recipient: string | null;
}
interface Event {
  event: string;
  hash?: string;
  targetBlock?: number;
  profitUsd?: number;
  kind?: string;
  netUsd?: number;
  costUsd?: number;
}

/** A failed attempt stops at its price check after about this much gas: 39-57k on real ones. */
const FAIL_GAS = 50_000;
const PUBLIC_SHARE = 0.05;
const MIN_NET_USD = 0.25;
/** Fee recipients of the builders that get our bundles: BuilderNet, Titan, the Flashbots builder and Quasar. */
const OUR_BUILDERS = new Set(['0xdadb0d80178819f2319190d340ce9a924f783711', '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97', '0xdf99a0839818b3f120ebac9b73f82b617dc6a555', '0x396343362be2a4da1ce0c1c210945346fb82aa49']);
const BUNDLE_LANDS = Number(args.land);
const RUNS = Number(args.runs);
const DAYS = Number(args.days);
const BLOCKS_PER_HOUR = 300;

const lines = <T>(file: string): T[] =>
  readFileSync(`data/${file}`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
const files = readdirSync('data').sort();
const isOwn = (kind: BlockKind): boolean => kind !== 'builder';

const kinds = new Map<number, KindRow>();
for (const file of files.filter((name) => /^proposers-.*\.jsonl$/.test(name))) for (const row of lines<KindRow>(file)) if (row.kind && !kinds.has(row.block)) kinds.set(row.block, row);

const trades = new Map<number, Trade[]>();
const seen = new Set<string>();
for (const file of files.filter((name) => /^paper-(live|replay)-.*-trades\.jsonl$/.test(name))) {
  for (const trade of lines<Trade>(file)) {
    const key = `${trade.targetBlock}:${trade.pools.join()}`;
    if (seen.has(key) || !kinds.has(trade.targetBlock)) continue;
    seen.add(key);
    trades.set(trade.targetBlock, [...(trades.get(trade.targetBlock) ?? []), trade]);
  }
}

// The odds each block had before it, as the sender would have known them.
const chanceAt = new Map<number, number>();
{
  const records = new Map<string, { blocks: number; own: number }>();
  let all = 0;
  let own = 0;
  for (const row of [...kinds.values()].sort((a, b) => a.block - b.block)) {
    const key = row.predicted ? 'no-relay' : (row.recipient ?? 'unknown');
    const record = records.get(key) ?? { blocks: 0, own: 0 };
    chanceAt.set(row.block, all > 500 ? (record.own + (own / all) * 20) / (record.blocks + 20) : own / Math.max(all, 1));
    record.blocks++;
    all++;
    if (isOwn(row.kind)) {
      record.own++;
      own++;
    }
    records.set(key, record);
  }
}

// Real attempts: what they aimed at and what came of them.
const events = files.filter((name) => name.endsWith('-real-live-sender.jsonl')).flatMap((name) => lines<Event>(name));
const settled = new Map(events.filter((event) => event.event === 'settled').map((event) => [event.hash, event]));
const sent = events.filter((event) => event.event === 'sent' && event.targetBlock !== undefined);
const rpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(CHAINS.ethereum!), 3, 15_000);
const attempts = await mapLimit(sent, 4, async (attempt) => {
  const known = kinds.get(attempt.targetBlock!);
  const kind = known?.kind ?? (await rpc.call<{ extraData: string }>('eth_getBlockByNumber', [`0x${attempt.targetBlock!.toString(16)}`, false]).then((block) => blockKind(block.extraData), () => null));
  const result = settled.get(attempt.hash);
  return { attempt, kind, predicted: known?.predicted ?? false, result, netUsd: result ? (result.kind === 'won' ? (result.netUsd ?? 0) : -(result.costUsd ?? 0)) : null };
});
const shots = attempts.filter((row) => row.kind !== null && isOwn(row.kind) && row.netUsd !== null);
const shotWins = shots.filter((row) => row.result?.kind === 'won' && (row.netUsd ?? 0) > 0);
const builderTries = attempts.filter((row) => row.kind === 'builder' && row.netUsd !== null);
const WIN_IN_SELF_BUILT = shots.length > 0 ? shotWins.length / shots.length : 2 / 3;
const REALIZED = shotWins.length > 0 ? shotWins.reduce((total, row) => total + (row.netUsd ?? 0) / (row.attempt.profitUsd ?? 1), 0) / shotWins.length : 0.8;
const bundles = events.filter((event) => event.event === 'bundle').length;
const landed = events.filter((event) => event.event === 'sent' && (event as { bundle?: boolean }).bundle).length;

interface Value {
  usd: number;
  attempts: number;
  wins: number;
  wonUsd: number;
  lostUsd: number;
  bundleUsd: number;
}
const none = (): Value => ({ usd: 0, attempts: 0, wins: 0, wonUsd: 0, lostUsd: 0, bundleUsd: 0 });

interface Rule {
  name: string;
  public: 'sure' | 'odds' | 'all';
  safety?: number;
  tipCapUsd?: number;
  bundleShare?: number;
  /** The bid is paid as a tip from the wallet, which must hold all of it up front. */
  walletUsd?: number;
}

const isOpen = (trade: Trade): boolean => !(trade.closedByTxs ?? []).length;

/** What one block is worth under a rule, on average. One attempt per block, with its best route. */
function valueOf(blockTrades: Trade[], rule: Rule): Value {
  const block = blockTrades[0]!.targetBlock;
  const kind = kinds.get(block)!;
  const selfBuilt = isOwn(kind.kind);
  const trade = [...blockTrades].sort((a, b) => b.profitUsd - a.profitUsd)[0]!;
  const units = Number(trade.gasUnits);
  const tipUsd = Math.min(trade.profitUsd * PUBLIC_SHARE, rule.tipCapUsd ?? Infinity);
  const failUsd = ((trade.gasUsd + tipUsd) / units) * FAIL_GAS;
  const winUsd = trade.profitUsd * REALIZED - trade.gasUsd - tipUsd;
  const chance = (chanceAt.get(block) ?? 0) * WIN_IN_SELF_BUILT;
  const goPublic = rule.public === 'all' || kind.predicted || (rule.public === 'odds' && chance * winUsd > (1 - chance) * failUsd * (rule.safety ?? 2));
  if (goPublic) {
    if (selfBuilt && isOpen(trade)) {
      const won = WIN_IN_SELF_BUILT * winUsd;
      const lost = -(1 - WIN_IN_SELF_BUILT) * failUsd;
      return { ...none(), usd: won + lost, attempts: 1, wins: WIN_IN_SELF_BUILT, wonUsd: won, lostUsd: lost };
    }
    return { ...none(), usd: -failUsd, attempts: 1, lostUsd: -failUsd };
  }
  if (!rule.bundleShare || selfBuilt || !OUR_BUILDERS.has(trade.builder?.toLowerCase() ?? '')) return none();
  const bid = trade.profitUsd * rule.bundleShare;
  if (trade.profitUsd - bid - trade.gasUsd < MIN_NET_USD) return none();
  if (rule.walletUsd !== undefined && bid * 1.3 > rule.walletUsd) return none();
  const beats = isOpen(trade) || (Number.isFinite(trade.rivalPaymentUsd) && trade.rivalPaymentUsd < bid);
  // The contract refuses to finish below its costs, so a bundle that would lose is thrown away for free.
  const kept = beats ? BUNDLE_LANDS * (trade.profitUsd - bid - trade.gasUsd) : 0;
  return { ...none(), usd: kept, wins: beats ? BUNDLE_LANDS : 0, bundleUsd: kept };
}

const RULES: Rule[] = [
  { name: 'сейчас: открыто только в почти верные слоты, пакеты 25% с кошелька', public: 'sure', bundleShare: 0.25, walletUsd: 20 },
  { name: 'пакеты 50% с кошелька', public: 'sure', bundleShare: 0.5, walletUsd: 20 },
  { name: 'пакеты 50% из прибыли (нужен новый контракт)', public: 'sure', bundleShare: 0.5 },
  { name: 'пакеты 90% из прибыли (нужен новый контракт)', public: 'sure', bundleShare: 0.9 },
  { name: 'открыто по шансам слота с запасом x2', public: 'odds', safety: 2, tipCapUsd: 0.5, bundleShare: 0.25, walletUsd: 20 },
  { name: 'открыто везде, чаевые до $0.50', public: 'all', tipCapUsd: 0.5 },
];

const hours = new Map<number, Value[]>();
for (const block of kinds.keys()) {
  const hour = Math.floor(block / BLOCKS_PER_HOUR);
  if (!hours.has(hour)) hours.set(hour, RULES.map(none));
}
const OUTLIERS = 2;
const left = RULES.map((): { block: number; usd: number }[] => []);
RULES.forEach((rule, i) => {
  const values = [...trades.values()].map((blockTrades) => ({ block: blockTrades[0]!.targetBlock, value: valueOf(blockTrades, rule) }));
  const best = new Set(values.filter(({ value }) => value.usd > 0).sort((a, b) => b.value.usd - a.value.usd).slice(0, OUTLIERS).map(({ block }) => block));
  for (const { block, value } of values) {
    if (best.has(block)) {
      left[i]!.push({ block, usd: value.usd });
      continue;
    }
    const hour = hours.get(Math.floor(block / BLOCKS_PER_HOUR))![i]!;
    for (const key of Object.keys(value) as (keyof Value)[]) hour[key] += value[key];
  }
});
const recorded = [...hours.values()];
const recordedDays = (kinds.size * 12) / 86_400;
const quantile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const whole = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(0)}`;
const monthLine = (months: number[]): string => {
  months.sort((a, b) => a - b);
  const share = (test: (m: number) => boolean): string => `${((100 * months.filter(test).length) / months.length).toFixed(0)}%`;
  return `за ${DAYS} дней: медиана ${whole(quantile(months, 0.5))}, 5% худших ниже ${whole(quantile(months, 0.05))}, 5% лучших выше ${whole(quantile(months, 0.95))}; в минусе ${share((m) => m < 0)}, выше $100 ${share((m) => m > 100)}`;
};

console.log(`Записано ${kinds.size} блоков (${(recordedDays * 24).toFixed(1)} ч), сделки в ${trades.size} из них.`);
console.log(`По реальным попыткам: в блоках валидаторов выиграно ${shotWins.length} из ${shots.length}, при победе приходит ${(100 * REALIZED).toFixed(0)}% ожидаемого; в блоках билдеров ${builderTries.length} попыток, итог ${money(builderTries.reduce((total, row) => total + (row.netUsd ?? 0), 0))}.`);
console.log(`Пакеты: попало ${landed} из ${bundles}. Ниже считается, что попадает ${(100 * BUNDLE_LANDS).toFixed(0)}% выигрывающих (--land).`);

RULES.forEach((rule, i) => {
  const perDay = (key: keyof Value): number => recorded.reduce((total, hour) => total + hour[i]![key], 0) / recordedDays;
  const months: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    let sum = 0;
    for (let h = 0; h < DAYS * 24; h++) sum += recorded[Math.floor(Math.random() * recorded.length)]![i]!.usd;
    months.push(sum);
  }
  console.log(`\n${rule.name}`);
  console.log(`  в сутки ${money(perDay('usd'))}: открытые победы ${money(perDay('wonUsd'))}, открытые неудачи ${money(perDay('lostUsd'))}, пакеты ${money(perDay('bundleUsd'))}; открытых попыток ${perDay('attempts').toFixed(0)}`);
  if (left[i]!.length > 0) console.log(`  не вошли, как разовые: ${left[i]!.map(({ block, usd }) => `блок ${block} ${money(usd)}`).join(', ')}`);
  console.log(`  ${monthLine(months)}`);
});

// Real shots: draws the rate too, since a handful of shots says little about it.
const sureShots = shots.filter((row) => row.predicted).length;
const firstReal = Math.min(...sent.map((event) => event.targetBlock!));
const sureDays = ([...kinds.keys()].filter((block) => block >= firstReal).length * 12) / 86_400;
const outcomes = shots.map((row) => row.netUsd ?? 0);
if (sureShots > 0 && outcomes.length > 0) {
  const gamma = (k: number): number => {
    let sum = 0;
    for (let i = 0; i < k; i++) sum -= Math.log(Math.random());
    return sum;
  };
  const poisson = (rate: number): number => {
    let n = 0;
    let p = Math.exp(-rate);
    let cumulative = p;
    const u = Math.random();
    while (u > cumulative) {
      n++;
      p *= rate / n;
      cumulative += p;
    }
    return n;
  };
  const months: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const rate = gamma(sureShots) / sureDays;
    let sum = 0;
    for (let d = 0; d < DAYS; d++) for (let n = poisson(rate); n > 0; n--) sum += outcomes[Math.floor(Math.random() * outcomes.length)]!;
    months.push(sum);
  }
  console.log(`\nВыстрелы по реальным исходам: ${sureShots} в почти верных слотах за ${(sureDays * 24).toFixed(0)} ч, исходы ${outcomes.map(money).join(', ')}`);
  console.log(`  ${monthLine(months)}`);
}
process.exit(0);
