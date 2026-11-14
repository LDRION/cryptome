import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { mapLimit } from '../rpc.ts';
import type { PaperSummary } from './report.ts';

/**
 * Replays the same blocks under different settings and prints one line for each. Every run
 * reads the same stored data, so results differ only because the settings do.
 */

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    'bid-share': { type: 'string', default: '0.85' },
    'min-net': { type: 'string', default: '1' },
    haircut: { type: 'string', default: '0.1' },
    infra: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '3' },
    name: { type: 'string', default: 'sweep' },
    'all-builders': { type: 'boolean', default: false },
    universe: { type: 'string' },
    'self-built': { type: 'boolean', default: false },
    'include-blank': { type: 'boolean', default: false },
    'public-always': { type: 'boolean', default: false },
  },
});

export interface SweepSetting {
  bidShare: number;
  minNet: number;
  haircut: number;
}

const list = (text: string): number[] => text.split(',').map(Number);

export function settingsGrid(bidShares: number[], minNets: number[], haircuts: number[]): SweepSetting[] {
  return bidShares.flatMap((bidShare) => minNets.flatMap((minNet) => haircuts.map((haircut) => ({ bidShare, minNet, haircut }))));
}

const labelOf = (setting: SweepSetting): string => `${args.name}-b${setting.bidShare}-m${setting.minNet}-h${setting.haircut}`;

const runOne = (setting: SweepSetting): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--env-file-if-exists=.env',
        'src/paper/run.ts',
        '--mode',
        'replay',
        ...(args.from ? ['--from', args.from] : []),
        ...(args.to ? ['--to', args.to] : []),
        '--bid-share',
        String(setting.bidShare),
        '--min-net',
        String(setting.minNet),
        '--haircut',
        String(setting.haircut),
        '--label',
        labelOf(setting),
        '--skip-mid-block',
        ...(args['all-builders'] ? ['--all-builders'] : []),
        ...(args.universe ? ['--universe', args.universe] : []),
        ...(args['self-built'] ? ['--self-built'] : []),
        ...(args['include-blank'] ? ['--include-blank'] : []),
        ...(args['public-always'] ? ['--public-always'] : []),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-800);
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${labelOf(setting)} failed: ${tail}`))));
  });

const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(0)}`;

const settings = settingsGrid(list(args['bid-share']), list(args['min-net']), list(args.haircut));
console.error(`Настроек: ${settings.length}`);
let finished = 0;
await mapLimit(settings, Number(args.concurrency), async (setting) => {
  await runOne(setting);
  console.error(`  готово ${++finished}/${settings.length}: ${labelOf(setting)}`);
});

const files = await readdir('data');
const rows: { setting: SweepSetting; summary: PaperSummary }[] = [];
for (const setting of settings) {
  const suffix = `-${labelOf(setting)}.json`;
  const latest = files.filter((file) => file.endsWith(suffix)).sort().at(-1);
  if (!latest) continue;
  rows.push({ setting, summary: JSON.parse(await readFile(`data/${latest}`, 'utf8')) as PaperSummary });
}

const infra = Number(args.infra);
console.log('\nдоля  порог запас | отпр. EVM да/нет | побед реал лют | реальный/сут  после инфр | лютый/сут | мягкий/сут');
for (const { setting, summary } of rows) {
  const { scenarios, sent, evm, blocks } = summary.stats;
  const days = (blocks * summary.blockTime) / 86_400;
  const perDay = (x: number): number => (days > 0 ? x / days : 0);
  const real = scenarios.realistic;
  const brutal = scenarios.brutal;
  console.log(
    `${String(setting.bidShare).padEnd(5)} ${String(setting.minNet).padEnd(5)} ${String(setting.haircut).padEnd(5)}| ${String(sent).padStart(5)} ${String(evm.proved).padStart(4)}/${String(evm.rejected).padEnd(5)}| ${String(real.outcomes.won).padStart(5)} ${String(brutal.outcomes.won).padStart(4)} ${String(real.losingTrades + brutal.losingTrades).padStart(2)} | ${money(perDay(real.netUsd)).padStart(11)} ${money(perDay(real.netUsd) - infra).padStart(11)} | ${money(perDay(brutal.netUsd)).padStart(9)} | ${money(perDay(scenarios.optimistic.netUsd)).padStart(9)}`,
  );
}
await writeFile(`data/sweep-${args.name}.json`, JSON.stringify(rows.map(({ setting, summary }) => ({ setting, stats: summary.stats, blockTime: summary.blockTime })), null, 2));
