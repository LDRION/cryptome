import { readdir, readFile } from 'node:fs/promises';

const files = (await readdir('data')).filter((f) => /^recon-[a-z]+-/.test(f)).sort();
const latest = new Map<string, string>();
for (const file of files) latest.set(file.split('-')[1]!, file);

const round = (x: number): number => Math.round(x);
const rows: Record<string, unknown>[] = [];
const niches: Record<string, unknown>[] = [];

// Trace results for the same sample, since detected figures overstate native-leg routes.
const tracedNetPerDay = async (file: string): Promise<number | string> => {
  try {
    const traced = JSON.parse(await readFile(`data/${file.replace('recon-', 'payments-')}`, 'utf8'));
    return round(traced.netAfterAttemptsPerDay);
  } catch {
    return 'no traces';
  }
};

for (const [chain, file] of latest) {
  const s = JSON.parse(await readFile(`data/${file}`, 'utf8'));
  rows.push({
    chain,
    min: round(s.chainMinutes),
    failed: s.failedBlocks,
    arbs: s.arb.count,
    liqs: s.liquidation.count,
    'tracedNet/d': await tracedNetPerDay(file),
    'detected/d': round(s.perDay.grossUsd),
    'gas/d': round(s.perDay.gasUsd),
    'pessNet/d': round(s.perDay.pessimisticNetUsd),
    low: round(s.perDay.pessimisticNet90[0]),
    high: round(s.perDay.pessimisticNet90[1]),
    medianArb: +s.arb.perHitUsd.median.toFixed(3),
    top1: +s.concentration.top1.toFixed(2),
    top3: +s.concentration.top3.toFixed(2),
    bots: s.concentration.contracts,
    'profitable/repeat': `${s.repeatBots.profitable}/${s.repeatBots.count}`,
  });
  for (const n of s.niches.slice(0, 6)) {
    niches.push({ chain, niche: String(n.key).slice(0, 34), hits: n.hits, bots: n.bots, gross: round(n.grossUsd), gas: round(n.ownGasUsd), topBot: +n.topBotShare.toFixed(2) });
  }
}

console.table(rows);
console.table(niches);
