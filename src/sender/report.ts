import { readdirSync, readFileSync } from 'node:fs';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { blockKind } from '../paper/proposers.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { GAS_BANDS, gasBandOf, totalsBy, type GroupTotals } from './results.ts';

/**
 * Looks for patterns in everything the real sender has done: where it wins, where it burns money and
 * what it refused. It only reads. The more attempts there are, the more these tables mean.
 */

interface Sent {
  event: 'sent';
  hash: string;
  targetBlock: number;
  routes?: number;
  profitUsd: number;
  placed?: boolean;
  raised?: boolean;
  tipWeiPerGas?: string;
}
interface Settled {
  event: 'settled';
  hash: string;
  kind: string;
  netUsd?: number;
  costUsd?: number;
}
interface Refused {
  event: 'refused';
  reason: string;
  targetBlock?: number;
  profitUsd?: number;
}

const rpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(CHAINS.ethereum!), 3, 15_000);
const events = readdirSync('data')
  .filter((file) => file.endsWith('-real-live-sender.jsonl'))
  .sort()
  .flatMap((file) => readFileSync(`data/${file}`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Sent | Settled | Refused | { event: string }));
const sent = events.filter((event): event is Sent => event.event === 'sent');
const settled = new Map(events.filter((event): event is Settled => event.event === 'settled').map((event) => [event.hash, event]));

const known = (
  await mapLimit(sent, 4, async (attempt) => {
    const result = settled.get(attempt.hash);
    if (!result) return null;
    const block = await rpc.call<{ extraData: string; baseFeePerGas: string }>('eth_getBlockByNumber', [`0x${attempt.targetBlock.toString(16)}`, false]).catch(() => null);
    if (!block) return null;
    const kind = blockKind(block.extraData);
    return {
      kind: kind === 'builder' ? 'билдер' : 'валидатор',
      baseFeeGwei: Number(BigInt(block.baseFeePerGas)) / 1e9,
      style: attempt.placed ? 'за чужой транзакцией' : attempt.raised ? 'с поднятыми чаевыми' : 'обычная',
      expectedUsd: attempt.profitUsd,
      won: result.kind === 'won' && (result.netUsd ?? 0) > 0,
      netUsd: result.kind === 'won' ? (result.netUsd ?? 0) : -(result.costUsd ?? 0),
    };
  })
).filter((row) => row !== null);

const money = (x: number): string => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
const table = (title: string, groups: Map<string, GroupTotals>, order?: readonly string[]): void => {
  console.log(`\n${title}`);
  for (const key of order ?? [...groups.keys()]) {
    const group = groups.get(key);
    if (!group) continue;
    console.log(`  ${key.padEnd(22)} попыток ${String(group.attempts).padStart(3)}, побед ${String(group.wins).padStart(2)}, заработано ${money(group.wonUsd).padStart(8)}, потеряно ${money(group.lostUsd).padStart(8)}, итог ${money(group.wonUsd + group.lostUsd).padStart(8)}`);
  }
};

const total = known.reduce((sum, row) => sum + row.netUsd, 0);
console.log(`Завершённых попыток: ${known.length} из ${sent.length} отправленных. Итог по сделкам: ${money(total)}`);
table('По тому, кто собрал блок:', totalsBy(known, (row) => row.kind));
table('По газу в блоке:', totalsBy(known, (row) => gasBandOf(row.baseFeeGwei)), GAS_BANDS.map((band) => band.name));
table('По виду попытки:', totalsBy(known, (row) => row.style));
table('По ожидаемой прибыли:', totalsBy(known, (row) => (row.expectedUsd < 1 ? 'до $1' : row.expectedUsd < 5 ? '$1-5' : row.expectedUsd < 20 ? '$5-20' : 'от $20')), ['до $1', '$1-5', '$5-20', 'от $20']);

const bundles = events.filter((event) => event.event === 'bundle') as { profitUsd?: number }[];
const landed = events.filter((event) => event.event === 'sent' && (event as { bundle?: boolean }).bundle) as Sent[];
const landedHashes = new Set(landed.map((event) => event.hash));
const bundleNet = [...settled.values()].filter((event) => landedHashes.has(event.hash)).reduce((total, event) => total + (event.kind === 'won' ? (event.netUsd ?? 0) : -(event.costUsd ?? 0)), 0);
if (bundles.length > 0) console.log(`\nЧастные пакеты билдерам: отправлено ${bundles.length} на ${bundles.reduce((total, bundle) => total + (bundle.profitUsd ?? 0), 0).toFixed(2)} по модели, попало в блок ${landed.length}, итог ${money(bundleNet)}`);
// Two bids run side by side. Per bid: how many went out, how many landed, and what the builder said.
const bids = new Map<string, number>();
for (const bundle of events.filter((event) => event.event === 'bundle') as { hash?: string; bidShare?: number }[]) if (bundle.hash && bundle.bidShare !== undefined) bids.set(bundle.hash, bundle.bidShare);
if (bids.size > 0) {
  const traced = new Map((events.filter((event) => event.event === 'bundle-trace') as { hash?: string; status?: string }[]).map((trace) => [trace.hash ?? '', trace.status ?? '?']));
  for (const share of [...new Set(bids.values())].sort((a, b) => a - b)) {
    const hashes = [...bids].filter(([, s]) => s === share).map(([hash]) => hash);
    const statuses = new Map<string, number>();
    for (const hash of hashes) if (traced.has(hash)) statuses.set(traced.get(hash)!, (statuses.get(traced.get(hash)!) ?? 0) + 1);
    console.log(`  ставка ${Math.round(share * 100)}%: пакетов ${hashes.length}, попало ${hashes.filter((hash) => landedHashes.has(hash)).length}${statuses.size ? `, у билдера: ${[...statuses].map(([s, n]) => `${s} ${n}`).join(', ')}` : ''}`);
  }
}
const checks = events.filter((event) => event.event === 'bundle-check') as { hash?: string; ok?: boolean; reason?: string; error?: string; valid?: boolean; invalid?: string }[];
const checked = checks.filter((check) => check.error === undefined);
if (checked.length > 0) {
  const top = (pick: (check: (typeof checked)[number]) => string | undefined): [string, number][] => {
    const counts = new Map<string, number>();
    for (const check of checked) {
      const reason = pick(check);
      if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  console.log(`  в самом начале своего блока прошли ${checked.filter((check) => check.ok).length} из ${checked.length} проверенных${checks.length > checked.length ? `, проверка не состоялась ${checks.length - checked.length}` : ''}`);
  for (const [reason, count] of top((check) => (check.ok ? undefined : (check.reason ?? '?')))) console.log(`    не прошли: ${count} — ${reason}`);
  const asked = checked.filter((check) => check.valid !== undefined);
  if (asked.length > 0) console.log(`  подписанные транзакции годны как есть (nonce, комиссии, баланс): ${asked.filter((check) => check.valid).length} из ${asked.length}`);
  for (const [reason, count] of top((check) => (check.valid === false ? (check.invalid ?? '?').replace(/0x[0-9a-fA-F]{40}/g, 'наш адрес') : undefined))) console.log(`    негодны: ${count} — ${reason}`);
}
// What a builder itself says it did with each bundle, the most direct answer there is.
const traces = events.filter((event) => event.event === 'bundle-trace') as { hash?: string; status?: string; error?: string }[];
if (traces.length > 0) {
  const count = (pick: (trace: (typeof traces)[number]) => string | undefined): string =>
    [...traces.reduce((counts, trace) => {
      const key = pick(trace);
      return key === undefined ? counts : counts.set(key, (counts.get(key) ?? 0) + 1);
    }, new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} ${n}`)
      .join(', ');
  console.log(`  что сказал о них сам билдер (Eureka), ${traces.length}: ${count((trace) => trace.status ?? 'не ответил')}`);
  const errors = count((trace) => trace.error);
  if (errors) console.log(`    его причины: ${errors}`);
  // Set against our own check. A bundle we found good that the builder could not simulate means our
  // simulation and his disagree, which is a fault of its own, apart from trades that honestly fail.
  const ours = new Map(checks.filter((check) => check.hash && check.error === undefined).map((check) => [check.hash!, check]));
  const verdict = (check: (typeof checks)[number] | undefined): string => (!check ? 'не проверен' : !check.ok ? 'у нас не проходит' : check.valid === false ? 'у нас негоден' : check.valid ? 'у нас годен' : 'годность неизвестна');
  const crossed = count((trace) => (trace.status ? `${trace.status} / ${verdict(ours.get(trace.hash ?? ''))}` : undefined));
  if (crossed) console.log(`    против нашей проверки: ${crossed}`);
  const disagree = traces.filter((trace) => /InitialSimulationFail|FailedToEnterOrderpool/.test(trace.status ?? '') && verdict(ours.get(trace.hash ?? '')) === 'у нас годен').length;
  if (disagree > 0) console.log(`    РАСХОЖДЕНИЕ: у нас годен, а билдер не смог смоделировать — ${disagree}`);
}

const refused = events.filter((event): event is Refused => event.event === 'refused');
const refusals = new Map<string, { count: number; worthUsd: number; ownBlocks: number; ownUsd: number }>();
const kinds = await mapLimit(refused, 4, async (event) => {
  if (event.targetBlock === undefined) return null;
  const block = await rpc.call<{ extraData: string }>('eth_getBlockByNumber', [`0x${event.targetBlock.toString(16)}`, false]).catch(() => null);
  return block ? blockKind(block.extraData) : null;
});
refused.forEach((event, i) => {
  const entry = refusals.get(event.reason) ?? { count: 0, worthUsd: 0, ownBlocks: 0, ownUsd: 0 };
  entry.count++;
  entry.worthUsd += event.profitUsd ?? 0;
  if (kinds[i] && kinds[i] !== 'builder') {
    entry.ownBlocks++;
    entry.ownUsd += event.profitUsd ?? 0;
  }
  refusals.set(event.reason, entry);
});
if (refusals.size > 0) {
  console.log('\nЧто не было отправлено и почему (сумма по модели, известна для новых записей):');
  for (const [reason, entry] of [...refusals.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(24)} ${String(entry.count).padStart(4)}, на $${entry.worthUsd.toFixed(2)}, из них в блоках валидаторов ${entry.ownBlocks} на $${entry.ownUsd.toFixed(2)}`);
  }
}
process.exit(0);
