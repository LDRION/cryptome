/**
 * The last line of defence once real gas is at stake. It runs outside the trading logic and
 * knows nothing about opportunities, so a bug in the search cannot talk it out of stopping.
 * Its state is saved, so that restarting the program cannot reset a limit that was reached.
 */

export interface RiskLimits {
  /** Net loss since the start of the UTC day that stops sending until the next day. */
  maxDailyLossUsd: number;
  /** Net loss over the whole run that stops sending for good. */
  maxTotalLossUsd: number;
  /** Spent on failed attempts in the last hour, whatever the wins were. */
  maxHourlyFailureUsd: number;
  /** The most one attempt may burn if it stops at its price check. */
  maxAttemptFailureUsd: number;
  /** Failures after the price check passed, in a row. These mean the model is wrong. */
  maxConsecutiveCostlyFailures: number;
  quarantineMs: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxDailyLossUsd: 10,
  maxTotalLossUsd: 100,
  maxHourlyFailureUsd: 3,
  // A tip raised to beat a rival is only chosen when the trade is worth it, and costs more if it fails.
  maxAttemptFailureUsd: 2,
  maxConsecutiveCostlyFailures: 5,
  quarantineMs: 24 * 3_600_000,
};

export type AttemptResult =
  | { kind: 'won'; netUsd: number }
  /** Stopped at the price check, as most attempts are expected to. */
  | { kind: 'stopped-early'; costUsd: number }
  /** Passed the check and failed anyway, which should almost never happen. */
  | { kind: 'costly-failure'; costUsd: number; pools: string[] }
  | { kind: 'not-included' };

export type Refusal = 'halted' | 'daily-loss-limit' | 'hourly-failure-limit' | 'attempt-too-costly' | 'pool-in-quarantine' | 'invalid-input';

export interface RiskState {
  haltReason: string | null;
  totalNetUsd: number;
  day: string;
  dayNetUsd: number;
  recentFailures: { at: number; usd: number }[];
  consecutiveCostlyFailures: number;
  quarantinedUntil: Record<string, number>;
}

const HOUR_MS = 3_600_000;
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

export const newRiskState = (now: number): RiskState => ({
  haltReason: null,
  totalNetUsd: 0,
  day: dayOf(now),
  dayNetUsd: 0,
  recentFailures: [],
  consecutiveCostlyFailures: 0,
  quarantinedUntil: {},
});

export class RiskGuard {
  readonly limits: RiskLimits;
  readonly state: RiskState;

  constructor(limits: RiskLimits, state: RiskState) {
    this.limits = limits;
    this.state = state;
  }

  private rollDay(now: number): void {
    const today = dayOf(now);
    if (this.state.day === today) return;
    this.state.day = today;
    this.state.dayNetUsd = 0;
  }

  private spentThisHour(now: number): number {
    this.state.recentFailures = this.state.recentFailures.filter((entry) => now - entry.at < HOUR_MS);
    return this.state.recentFailures.reduce((total, entry) => total + entry.usd, 0);
  }

  inQuarantine(pools: readonly string[], now: number): boolean {
    return pools.some((pool) => (this.state.quarantinedUntil[pool] ?? 0) > now);
  }

  /** Whether this attempt may leave. Anything it cannot read counts as a refusal. */
  check(attempt: { pools: string[]; failureCostUsd: number }, now: number): { ok: true } | { ok: false; reason: Refusal } {
    this.rollDay(now);
    if (!Number.isFinite(attempt.failureCostUsd) || attempt.failureCostUsd < 0) return { ok: false, reason: 'invalid-input' };
    if (this.state.haltReason !== null) return { ok: false, reason: 'halted' };
    if (this.state.dayNetUsd <= -this.limits.maxDailyLossUsd) return { ok: false, reason: 'daily-loss-limit' };
    if (attempt.failureCostUsd > this.limits.maxAttemptFailureUsd) return { ok: false, reason: 'attempt-too-costly' };
    // Counts this attempt as failed in advance, so the limit holds even if every one fails.
    if (this.spentThisHour(now) + attempt.failureCostUsd > this.limits.maxHourlyFailureUsd) return { ok: false, reason: 'hourly-failure-limit' };
    if (this.inQuarantine(attempt.pools, now)) return { ok: false, reason: 'pool-in-quarantine' };
    return { ok: true };
  }

  record(result: AttemptResult, now: number): void {
    this.rollDay(now);
    const net = result.kind === 'won' ? result.netUsd : result.kind === 'not-included' ? 0 : -result.costUsd;
    this.state.totalNetUsd += net;
    this.state.dayNetUsd += net;
    if (result.kind === 'stopped-early' || result.kind === 'costly-failure') this.state.recentFailures.push({ at: now, usd: result.costUsd });

    if (result.kind === 'won') this.state.consecutiveCostlyFailures = 0;
    if (result.kind === 'costly-failure') {
      this.state.consecutiveCostlyFailures++;
      for (const pool of result.pools) this.state.quarantinedUntil[pool] = now + this.limits.quarantineMs;
    }

    if (this.state.consecutiveCostlyFailures >= this.limits.maxConsecutiveCostlyFailures) {
      this.state.haltReason = `${this.state.consecutiveCostlyFailures} costly failures in a row`;
    }
    if (this.state.totalNetUsd <= -this.limits.maxTotalLossUsd) this.state.haltReason = `total loss reached $${this.limits.maxTotalLossUsd}`;
  }
}
