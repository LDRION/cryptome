import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Ranks every measured chain, using traced figures where they exist. Detected figures
 * count native legs as profit, so a chain without traces can only be a lead, not a result.
 */

interface ChainRow {
  chain: string;
  minutes: number;
  failedBlocks: number;
  txs: number;
  feesPerDay: number;
  arbs: number;
  contracts: number;
  grossPerDay: number;
  netPerDay: number;
  medianWinUsd: number;
  topShare: number;
  traced: boolean;
}

const latestByChain = (files: string[], prefix: string): Map<string, string> => {
  const latest = new Map<string, string>();
  for (const file of files.filter((f) => f.startsWith(prefix)).sort()) {
    const match = /^[a-z]+-([a-z]+)-/.exec(file);
    if (match) latest.set(match[1]!, file);
  }
  return latest;
};

export async function collectRows(): Promise<ChainRow[]> {
  const files = await readdir('data');
  const recons = latestByChain(files, 'recon-');
  const traces = latestByChain(files, 'payments-');
  const rows: ChainRow[] = [];

  for (const [chain, file] of recons) {
    const recon = JSON.parse(await readFile(`data/${file}`, 'utf8'));
    const perDay = 1440 / Math.max(recon.chainMinutes, 1);
    let traced = false;
    let grossPerDay: number = recon.grossUsd * perDay;
    let netPerDay: number = (recon.grossUsd - recon.botGasUsd) * perDay;
    let topShare: number = recon.concentration.top1;

    const traceFile = traces.get(chain);
    if (traceFile) {
      const trace = JSON.parse(await readFile(`data/${traceFile}`, 'utf8'));
      if (trace.source === file && trace.traced > 0) {
        traced = true;
        const coverage = trace.traced / Math.max(trace.traced + trace.failed, 1);
        grossPerDay = (trace.grossUsd / coverage) * perDay;
        netPerDay = trace.netAfterAttemptsPerDay;
        topShare = trace.topBotShareOfRetained;
      }
    }
    rows.push({
      chain,
      minutes: recon.chainMinutes,
      failedBlocks: recon.failedBlocks,
      txs: recon.txs,
      feesPerDay: recon.feesUsd * perDay,
      arbs: recon.arb.count,
      contracts: recon.concentration.contracts,
      grossPerDay,
      netPerDay,
      medianWinUsd: recon.arb.perHitUsd.median,
      topShare,
      traced,
    });
  }
  return rows.sort((a, b) => b.netPerDay - a.netPerDay);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const round = (x: number): number => Math.round(x);
  console.table(
    (await collectRows()).map((r) => ({
      chain: r.chain,
      min: round(r.minutes),
      'fail blk': r.failedBlocks,
      'fees/d': round(r.feesPerDay),
      arbs: r.arbs,
      bots: r.contracts,
      'gross/d': round(r.grossPerDay),
      'net/d': round(r.netPerDay),
      medWin: +r.medianWinUsd.toFixed(3),
      top1: +r.topShare.toFixed(2),
      traced: r.traced ? 'yes' : 'NO',
    })),
  );
}
