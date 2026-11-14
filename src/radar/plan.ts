import type { Market } from './sources.ts';

/**
 * What the radar measures and when it speaks up. A market is an EVM chain with DEX volume. Being
 * first matters, so a chain that shows up with real volume is measured on the pass it appears, and
 * a known one again each week or as soon as its volume doubles.
 */

export const RADAR = {
  /** A day of DEX volume below this leaves too little for any gap to be worth a trade. */
  MIN_VOLUME_USD: 2_000_000,
  REMEASURE_MS: 7 * 86_400_000,
  /** Recon on a public RPC takes a while and should not hammer it. */
  MAX_MEASURES_PER_PASS: 3,
  /** Bots' profit a day, after their gas and a pessimistic allowance, from which a market is worth a look. */
  TASTY_NET_PER_DAY_USD: 30,
  GROWTH_FACTOR: 2,
  /** Measured before, where professionals already hold the market (see README). */
  SKIP: new Set(['ethereum', 'base', 'arbitrum', 'bsc']),
} as const;

export interface Measured {
  at: number;
  volume24hUsd: number;
  /** What bots made a day there without the two biggest hits, after their gas and a pessimistic allowance. */
  netPerDayUsd?: number;
  /** The same with every hit, which one lucky trade can carry. */
  rawNetPerDayUsd?: number;
  grossPerDayUsd?: number;
  arbs?: number;
  liquidations?: number;
  bots?: number;
  /** Share of all bot profit taken by the biggest one. */
  top1Share?: number;
  minutes?: number;
  failedBlocks?: number;
  error?: string;
}

/** The parts of a recon summary that say what bots really make. */
export interface ReconSummary {
  chainMinutes: number;
  grossUsd: number;
  botGasUsd: number;
  pessimisticHiddenCostUsd: number;
  hits: { usd: number | null }[];
}

/** Hits left out of the money figure, as the month simulator leaves out each rule's two best blocks. */
export const OUTLIER_HITS = 2;

/**
 * What bots make a day without the two biggest hits of the sample, after their gas and a pessimistic
 * allowance. On OP Mainnet on 2026-11-07 one hit of $4.17 was 57% of all profit in 54 minutes of chain
 * time and the rest were fractions of a cent, so a plain total called it tasty when it was not.
 */
export function steadyNetPerDay(summary: ReconSummary): number {
  if (!(summary.chainMinutes > 0)) return 0;
  const best = summary.hits.map((hit) => hit.usd ?? 0).sort((a, b) => b - a).slice(0, OUTLIER_HITS).reduce((total, usd) => total + usd, 0);
  return ((summary.grossUsd - best - summary.botGasUsd - summary.pessimisticHiddenCostUsd) * 1440) / summary.chainMinutes;
}

export interface MarketRecord {
  firstSeenAt: number;
  /** Already there on the radar's first pass, so not news. */
  atStart: boolean;
  measured?: Measured;
  lastAlertAt?: Record<string, number>;
}

export interface RadarState {
  startedAt: number;
  markets: Record<string, MarketRecord>;
  /** Volume by market on each pass, the last month of them. */
  history: { at: number; volumes: Record<string, number> }[];
}

export interface Alert {
  kind: 'new-market' | 'growth' | 'money';
  slug: string;
  text: string;
}

export const newState = (now: number): RadarState => ({ startedAt: now, markets: {}, history: [] });

/** Which markets to measure on this pass: new ones first, then the most traded. */
export function toMeasure(markets: readonly Market[], state: RadarState, now: number): Market[] {
  const due = markets.filter((market) => {
    if (market.volume24hUsd < RADAR.MIN_VOLUME_USD || RADAR.SKIP.has(market.slug)) return false;
    const last = state.markets[market.slug]?.measured;
    if (!last) return true;
    if (last.error) return now - last.at >= RADAR.REMEASURE_MS / 7;
    return now - last.at >= RADAR.REMEASURE_MS || market.volume24hUsd >= last.volume24hUsd * RADAR.GROWTH_FACTOR;
  });
  const never = (market: Market): number => (state.markets[market.slug]?.measured ? 1 : 0);
  return due.sort((a, b) => never(a) - never(b) || b.volume24hUsd - a.volume24hUsd).slice(0, RADAR.MAX_MEASURES_PER_PASS);
}

/** The volume a market had about a week ago, from the passes on record. */
function weekAgo(state: RadarState, slug: string, now: number): number | undefined {
  const old = state.history.filter((entry) => now - entry.at >= RADAR.REMEASURE_MS - 12 * 3_600_000);
  return old.at(-1)?.volumes[slug];
}

/** Each kind of news about a market goes out at most once a week; the first time always does. */
const quietFor = (record: MarketRecord | undefined, kind: Alert['kind'], now: number): boolean => {
  const last = record?.lastAlertAt?.[kind];
  return last === undefined || now - last >= RADAR.REMEASURE_MS;
};

const millions = (usd: number): string => `$${(usd / 1e6).toFixed(1)}M`;

/** News about the markets themselves: one that appeared with real volume, or one whose volume doubled in a week. */
export function marketAlerts(markets: readonly Market[], state: RadarState, now: number): Alert[] {
  const alerts: Alert[] = [];
  const firstPass = state.history.length === 0;
  for (const market of markets) {
    if (market.volume24hUsd < RADAR.MIN_VOLUME_USD) continue;
    const record = state.markets[market.slug];
    if (!firstPass && !record && quietFor(record, 'new-market', now)) {
      alerts.push({ kind: 'new-market', slug: market.slug, text: `Новый рынок: ${market.name}, объём бирж ${millions(market.volume24hUsd)} за сутки, ликвидность ${millions(market.tvlUsd)}` });
    }
    const before = weekAgo(state, market.slug, now);
    if (before !== undefined && before > 0 && market.volume24hUsd >= before * RADAR.GROWTH_FACTOR && quietFor(record, 'growth', now)) {
      alerts.push({ kind: 'growth', slug: market.slug, text: `${market.name}: объём бирж вырос в ${(market.volume24hUsd / before).toFixed(1)} раза за неделю, до ${millions(market.volume24hUsd)}` });
    }
  }
  return alerts;
}

/** What a measurement says: money worth a look, or nothing to report. */
export function measuredAlert(market: Market, measured: Measured, record: MarketRecord | undefined, now: number): Alert | null {
  if (measured.error || measured.netPerDayUsd === undefined || measured.netPerDayUsd < RADAR.TASTY_NET_PER_DAY_USD || !quietFor(record, 'money', now)) return null;
  const top = measured.top1Share !== undefined ? `, у крупнейшего бота ${Math.round(measured.top1Share * 100)}%` : '';
  return { kind: 'money', slug: market.slug, text: `${market.name}: боты зарабатывают около $${measured.netPerDayUsd.toFixed(0)} в сутки после газа даже без двух лучших сделок, ботов ${measured.bots ?? '?'}${top}. Стоит замерить нашим движком` };
}

/** Folds a pass into the state: who was seen, what was measured, which alerts went out. */
export function afterPass(state: RadarState, markets: readonly Market[], measured: ReadonlyMap<string, Measured>, alerts: readonly Alert[], now: number): RadarState {
  const firstPass = state.history.length === 0;
  const next: RadarState = { ...state, markets: { ...state.markets }, history: [...state.history, { at: now, volumes: Object.fromEntries(markets.map((m) => [m.slug, m.volume24hUsd])) }].slice(-150) };
  for (const market of markets) {
    if (market.volume24hUsd < RADAR.MIN_VOLUME_USD && !next.markets[market.slug]) continue;
    next.markets[market.slug] = { ...(next.markets[market.slug] ?? { firstSeenAt: now, atStart: firstPass }) };
  }
  for (const [slug, result] of measured) next.markets[slug] = { ...(next.markets[slug] ?? { firstSeenAt: now, atStart: firstPass }), measured: result };
  for (const alert of alerts) {
    const record = next.markets[alert.slug] ?? { firstSeenAt: now, atStart: firstPass };
    next.markets[alert.slug] = { ...record, lastAlertAt: { ...record.lastAlertAt, [alert.kind]: now } };
  }
  return next;
}
