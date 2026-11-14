import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { RiskLimits } from './risk.ts';

/**
 * The every-block experiment, asked for on 2026-11-10: every trade found goes out publicly, in every slot,
 * with no doubt about the slot and no allowance for expected failures, until the total has fallen a fixed
 * budget below where it stood at the start. The start is kept in a file, so a restart does not reset it.
 * Past data said this loses (72 public attempts at builder blocks, no win, -$5.30); this measures it again.
 */

export interface Experiment {
  startedAt: string;
  /** The sender's total when the experiment began. */
  startNetUsd: number;
  lossBudgetUsd: number;
}

/** One failure may cost at most this, so a single dear attempt cannot spend the whole budget. */
export const EXPERIMENT_ATTEMPT_CAP_USD = 0.15;

/** The usual limits, with the total loss counted from the experiment's start and a smaller cap per attempt. */
export function experimentLimits(base: RiskLimits, experiment: Experiment): RiskLimits {
  return {
    ...base,
    maxTotalLossUsd: experiment.lossBudgetUsd - experiment.startNetUsd,
    maxAttemptFailureUsd: Math.min(base.maxAttemptFailureUsd, EXPERIMENT_ATTEMPT_CAP_USD),
  };
}

/** The experiment under way, or a new one starting from the total as it stands now. */
export function loadOrStartExperiment(file: string, totalNetUsd: number, lossBudgetUsd: number, now: Date): Experiment {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Experiment;
  const experiment: Experiment = { startedAt: now.toISOString(), startNetUsd: totalNetUsd, lossBudgetUsd };
  writeFileSync(file, JSON.stringify(experiment, null, 2));
  return experiment;
}
