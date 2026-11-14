/**
 * What each finished attempt came to, in a form a person can read at a glance and a report can
 * add up. It runs only after an attempt has settled, so it never slows one down.
 */

export interface ResultRow {
  at: number;
  hash: string;
  targetBlock: number;
  minedBlock: number | null;
  /** Who built the block it aimed at, if known. */
  blockKind: string | null;
  result: 'won' | 'stopped-early' | 'costly-failure' | 'not-included';
  netUsd: number;
  expectedUsd: number;
  routes: number;
  /** It took a place right behind a pending transaction. */
  placed: boolean;
  /** Its tip was raised at the last moment to go ahead of a pending rival. */
  raised: boolean;
  tipGwei: number;
  baseFeeGwei: number;
  gasUsed: number;
  totalNetUsd: number;
}

export const RESULTS_HEADER = 'time,hash,target_block,mined_block,block_kind,result,net_usd,expected_usd,routes,placed,raised,tip_gwei,base_fee_gwei,gas_used,total_net_usd';

export function resultCsv(row: ResultRow): string {
  return [
    new Date(row.at).toISOString(),
    row.hash,
    row.targetBlock,
    row.minedBlock ?? '',
    row.blockKind ?? '',
    row.result,
    row.netUsd.toFixed(4),
    row.expectedUsd.toFixed(4),
    row.routes,
    row.placed ? 1 : 0,
    row.raised ? 1 : 0,
    row.tipGwei.toFixed(6),
    row.baseFeeGwei.toFixed(6),
    row.gasUsed,
    row.totalNetUsd.toFixed(4),
  ].join(',');
}

const signed = (usd: number): string => `${usd < 0 ? '-' : '+'}$${Math.abs(usd).toFixed(2)}`;
const KIND_NAME: Record<string, string> = { validator: 'валидатор', blank: 'валидатор', builder: 'билдер' };
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function why(row: ResultRow): string {
  if (row.result === 'costly-failure') return 'дорогая неудача: прошла проверку и всё равно откатилась';
  if (row.minedBlock !== null && row.minedBlock > row.targetBlock) return `опоздала на ${row.minedBlock - row.targetBlock} бл.`;
  return 'разрыв закрыли раньше нас';
}

/** One line that says at a glance whether this attempt made or lost money, and the running totals. */
export function resultLine(row: ResultRow, sessionNetUsd: number): string {
  const time = new Date(row.at).toLocaleTimeString('ru-RU', { hour12: false });
  const kind = row.blockKind ? ` (${KIND_NAME[row.blockKind] ?? row.blockKind})` : '';
  const what = row.placed ? 'за чужой транзакцией' : `маршрутов ${row.routes}`;
  const head = row.netUsd > 0 ? `${GREEN}✅ ПЛЮС ${signed(row.netUsd)}${RESET}` : `${RED}❌ МИНУС ${signed(row.netUsd)}${RESET}`;
  const detail = row.netUsd > 0 ? `ждали $${row.expectedUsd.toFixed(2)}` : `ждали $${row.expectedUsd.toFixed(2)}, ${why(row)}`;
  return `  ${time} ${head} | блок ${row.targetBlock}${kind}, ${what} | ${detail} | газ ${row.baseFeeGwei.toFixed(2)} гвей | за запуск ${signed(sessionNetUsd)}, всего ${signed(row.totalNetUsd)}`;
}

export const GAS_BANDS: readonly { name: string; below: number }[] = [
  { name: 'до 0.2 гвей', below: 0.2 },
  { name: '0.2-1 гвей', below: 1 },
  { name: '1-3 гвей', below: 3 },
  { name: 'от 3 гвей', below: Number.POSITIVE_INFINITY },
];

export const gasBandOf = (baseFeeGwei: number): string => GAS_BANDS.find((band) => baseFeeGwei < band.below)!.name;

export interface GroupTotals {
  attempts: number;
  wins: number;
  wonUsd: number;
  lostUsd: number;
}

/** Adds attempts up by whatever the key says, in the order the keys first appear. */
export function totalsBy<T extends { netUsd: number; won: boolean }>(rows: readonly T[], keyOf: (row: T) => string): Map<string, GroupTotals> {
  const groups = new Map<string, GroupTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { attempts: 0, wins: 0, wonUsd: 0, lostUsd: 0 };
    group.attempts++;
    if (row.won) group.wins++;
    if (row.netUsd > 0) group.wonUsd += row.netUsd;
    else group.lostUsd += row.netUsd;
    groups.set(key, group);
  }
  return groups;
}

/** How many times the usual fee counts as a surge, and how far back it must fall to count as over. */
const SURGE_FACTOR = 3;
const CALM_FACTOR = 1.5;
const USUAL_OVER_BLOCKS = 300;
const MIN_BLOCKS = 25;

/**
 * Notices when gas leaves its usual range. It only reports: what a higher fee does to each trade is
 * already worked out from the exact fee of the next block, which the protocol lets rise at most
 * 12.5% a block. So there is nothing to foresee in order to avoid overpaying.
 */
export class GasWatch {
  private readonly recent: number[] = [];
  private usual: number | null = null;
  surging = false;

  /** Returns a line to show when the state changes, and null otherwise. */
  note(baseFeeGwei: number): string | null {
    let line: string | null = null;
    if (this.recent.length >= MIN_BLOCKS) {
      const usual = this.usual ?? [...this.recent].sort((a, b) => a - b)[Math.floor(this.recent.length / 2)]!;
      if (!this.surging && baseFeeGwei > usual * SURGE_FACTOR) {
        this.surging = true;
        this.usual = usual;
        line = `⚠ Газ вырос: ${baseFeeGwei.toFixed(2)} гвей при обычных ${usual.toFixed(2)}. Неудачи стоят дороже, мелкие сделки отсеиваются сами.`;
      } else if (this.surging && baseFeeGwei < usual * CALM_FACTOR) {
        this.surging = false;
        this.usual = null;
        line = `✓ Газ вернулся к обычному: ${baseFeeGwei.toFixed(2)} гвей.`;
      }
    }
    // The surge itself must not become the new usual.
    if (!this.surging) {
      this.recent.push(baseFeeGwei);
      if (this.recent.length > USUAL_OVER_BLOCKS) this.recent.shift();
    }
    return line;
  }
}
