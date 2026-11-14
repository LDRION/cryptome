import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { PaperStats, Scenario } from './engine.ts';
import type { RecallStats } from './recall.ts';
import type { Visibility, VisibilityStats } from './streams.ts';

interface ModelLine {
  checks: number;
  medianError: number;
  p99Error: number;
}

export interface PaperSummary {
  mode: 'replay' | 'live';
  startedAt: string;
  updatedAt: string;
  fromBlock: number;
  lastBlock: number;
  blockTime: number;
  universe: { pools: number; v2?: number; v3?: number; v4?: number; routes: number; splitBlock: number };
  assumptions: { bidShare: number; profitHaircut: number; minNetUsd: number; infraUsdPerDay: number; startBalanceUsd: number };
  stats: PaperStats;
  model: { v2: ModelLine; v3: ModelLine; v4?: ModelLine; crossing?: ModelLine };
  depthPools?: number;
  latencyMs: { median: number; p99: number };
  verifiedPools: number;
  visibility?: VisibilityStats;
  recall?: RecallStats;
}

const WORLD_LABEL: Record<Scenario, string> = {
  optimistic: 'Мягкий (конкурентов нет)',
  realistic: 'Реальный (побеждает большая выплата)',
  brutal: 'Лютый (любой соперник = проигрыш)',
};

const REFUSAL_LABEL: Record<string, string> = {
  'invalid-input': 'неисправные данные',
  'unvetted-route': 'пул или токен не проверены',
  'stale-state': 'устаревшее состояние',
  'loses-even-when-it-wins': 'убыточно даже при выигрыше',
  'negative-expected-value': 'отрицательное ожидание',
  'loss-budget-exhausted': 'исчерпан лимит убытка',
};

const VISIBILITY_LABEL: [Visibility, string][] = [
  ['mempool', 'мемпул'],
  ['mev-share-exact', 'MEV-Share точно'],
  ['mev-share-topics', 'MEV-Share по адресам'],
  ['mev-share-possible', 'MEV-Share возможно'],
  ['unseen', 'не видно'],
];

const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const percent = (x: number): string => `${(x * 100).toFixed(4)}%`;
const modelLine = (name: string, m: ModelLine): string => `${name} ${m.checks} шт., медиана ${percent(m.medianError)}, p99 ${percent(m.p99Error)}`;

export function formatReport(s: PaperSummary): string {
  const days = (s.stats.blocks * s.blockTime) / 86_400;
  const infra = s.assumptions.infraUsdPerDay * days;
  const u = s.universe;
  const lines = [
    '',
    `=== Эмулятор: ${s.mode === 'live' ? 'живой режим' : 'реплей'}, ВИРТУАЛЬНЫЕ деньги ===`,
    `Блоки ${s.fromBlock}..${s.lastBlock} (${s.stats.blocks}, ${(days * 24).toFixed(1)} ч сетевого времени)`,
    `Наблюдение: ${u.pools} пулов${u.v4 === undefined ? '' : ` (V2 ${u.v2}, V3 ${u.v3}, V4 ${u.v4})`}, ${u.routes} маршрутов, подтверждено реальными свапами ${s.verifiedPools} пулов`,
    '',
    `Разрывов цены найдено: ${s.stats.dislocations}`,
    `Отправлено понарошку: ${s.stats.sent}`,
    ...(s.stats.evm && s.stats.evm.proved + s.stats.evm.rejected > 0
      ? [`Проверка в настоящем EVM: прошло ${s.stats.evm.proved}, отклонено ${s.stats.evm.rejected}. На прошедших модель ${money(s.stats.evm.modelUsd)}, EVM ${money(s.stats.evm.evmUsd)}`]
      : []),
    'Гейт отказал:',
    ...Object.entries(s.stats.refusals).map(([reason, count]) => `  ${REFUSAL_LABEL[reason] ?? reason}: ${count}`),
    '',
  ];
  if (Object.keys(s.stats.refusals).length === 0) lines.splice(lines.length - 2, 1, 'Гейт отказал: 0');

  for (const world of ['optimistic', 'realistic', 'brutal'] as const) {
    const w = s.stats.scenarios[world];
    lines.push(
      `${WORLD_LABEL[world]}:`,
      `  Баланс ${money(s.assumptions.startBalanceUsd)} -> ${money(w.balanceUsd)} | итог ${money(w.netUsd)} | после инфраструктуры ${money(w.netUsd - infra)}`,
      `  Побед ${w.outcomes.won} | обошли ${w.outcomes['lost-to-rival']} | билдер не наш ${w.outcomes['not-included']} | откат проверкой ${w.outcomes['guard-reverted']} | не успели ${w.outcomes['too-slow']}`,
      `  Убыточных сделок ${w.losingTrades} | лучшая ${money(w.bestUsd)} | худшая ${money(w.worstUsd)}`,
    );
  }

  const { midBlock } = s.stats;
  const after = midBlock as { netOfGasUsd?: number; grossUsd?: number };
  lines.push(
    '',
    `Разрывы внутри блока (нужно видеть транзакции заранее): ${midBlock.routes} на ${money(after.netOfGasUsd ?? after.grossUsd ?? 0)} после газа, до выплат билдерам, ${midBlock.closedSameBlock} закрыты в том же блоке`,
    `Точность модели на реальных свапах: ${modelLine('V2', s.model.v2)}; ${modelLine('V3', s.model.v3)}${s.model.v4 ? `; ${modelLine('V4', s.model.v4)}` : ''}`,
  );
  if (s.model.crossing) lines.push(`Свапы через несколько тиков (глубина загружена для ${s.depthPools ?? 0} пулов): ${modelLine('проверено', s.model.crossing)}`);
  if (s.recall) {
    const r = s.recall;
    lines.push(`Найдено реальных побед ботов: ${r.found} из ${r.wins}, ${money(r.foundRetainedUsd)} из ${money(r.retainedUsd)} их остатка`);
  }
  if (s.mode === 'live') lines.push(`Задержка от блока до решения: медиана ${s.latencyMs.median.toFixed(0)} мс, p99 ${s.latencyMs.p99.toFixed(0)} мс`);
  if (s.visibility) {
    const v = s.visibility;
    lines.push('', `Видимость разрывов заранее (учтено блоков ${v.blocksCovered}, исключено из-за обрывов потоков ${v.blocksExcluded}):`);
    for (const b of v.buckets) {
      const parts = VISIBILITY_LABEL.map(([key, label]) => {
        const c = b.byClass[key];
        if (!c) return null;
        return `${label} ${c.count} (${b.usd > 0 ? `${((c.usd / b.usd) * 100).toFixed(0)}%` : '-'})`;
      }).filter(Boolean);
      lines.push(`  От ${money(b.minUsd)}: ${b.count} разрывов на ${money(b.usd)}`, `    ${parts.join(' | ')}`);
    }
  }
  lines.push(
    '',
    `Допущения: выплата билдеру ${(s.assumptions.bidShare * 100).toFixed(0)}% прибыли, запас на цену ${(s.assumptions.profitHaircut * 100).toFixed(0)}%, порог $${s.assumptions.minNetUsd}, инфраструктура $${s.assumptions.infraUsdPerDay}/день (оценка)`,
  );
  return lines.join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Sorted by start time in the name, so a live run and a replay compare fairly.
  const startTime = (name: string): string => name.replace(/^paper-(live|replay)-/, '');
  const file = (await readdir('data')).filter((f) => /^paper-(live|replay)-.*\.json$/.test(f)).sort((a, b) => startTime(a).localeCompare(startTime(b))).at(-1);
  if (!file) throw new Error('Нет данных эмулятора. Запусти pnpm paper:replay или pnpm paper:live');
  console.log(`Файл: data/${file}`);
  console.log(formatReport(JSON.parse(await readFile(`data/${file}`, 'utf8')) as PaperSummary));
}
