/**
 * Pre-flight check that every operation must pass before it leaves the machine. It only
 * does arithmetic on numbers the simulation already produced, so it adds no network
 * time. Anything missing, stale or nonsensical is refused: a skipped trade costs
 * nothing, while a wrong one costs money.
 */

export type FailureMode =
  /** A failed attempt is dropped by the builder and never lands, so it costs nothing. */
  | 'revert-protected'
  /** A failed attempt lands on-chain and its gas is paid. */
  | 'pays-gas';

export interface Opportunity {
  /** Profit from simulating against the newest known state, before any costs. */
  simulatedProfitUsd: number;
  /** Fee for the transaction if it lands and succeeds, including any L1 fee. */
  gasUsd: number;
  /** Payment to the builder or sequencer when the operation wins. */
  builderPaymentUsd: number;
  /** Gas burned when an attempt fails. Ignored under revert protection. */
  failureGasUsd: number;
  /** Measured chance of winning for this niche, from 0 to 1. */
  winProbability: number;
  /** Age of the state the simulation ran on. */
  stateAgeMs: number;
  /** True only when every token on the route is on the vetted list. */
  routeVetted: boolean;
  mode: FailureMode;
}

export interface GatePolicy {
  /** Share of simulated profit assumed lost to price movement before inclusion. */
  profitHaircut: number;
  minNetUsd: number;
  minExpectedValueUsd: number;
  maxStateAgeMs: number;
  /** What the strategy may still lose today. Zero stops all gas-paying attempts. */
  remainingLossBudgetUsd: number;
}

export type RefusalReason =
  | 'invalid-input'
  | 'unvetted-route'
  | 'stale-state'
  | 'loses-even-when-it-wins'
  | 'negative-expected-value'
  | 'loss-budget-exhausted';

export type Decision =
  | { send: true; worstCaseNetUsd: number; expectedValueUsd: number }
  | { send: false; reason: RefusalReason };

const isUsable = (x: number): boolean => Number.isFinite(x) && x >= 0;

export function decide(o: Opportunity, policy: GatePolicy): Decision {
  const inputs = [o.simulatedProfitUsd, o.gasUsd, o.builderPaymentUsd, o.failureGasUsd, o.stateAgeMs, policy.profitHaircut, policy.remainingLossBudgetUsd];
  if (!inputs.every(isUsable)) return { send: false, reason: 'invalid-input' };
  if (!(o.winProbability >= 0 && o.winProbability <= 1)) return { send: false, reason: 'invalid-input' };
  if (policy.profitHaircut > 1) return { send: false, reason: 'invalid-input' };

  if (!o.routeVetted) return { send: false, reason: 'unvetted-route' };
  if (!(o.stateAgeMs <= policy.maxStateAgeMs)) return { send: false, reason: 'stale-state' };

  const worstCaseNetUsd = o.simulatedProfitUsd * (1 - policy.profitHaircut) - o.gasUsd - o.builderPaymentUsd;
  if (!(worstCaseNetUsd >= policy.minNetUsd)) return { send: false, reason: 'loses-even-when-it-wins' };

  const failureCostUsd = o.mode === 'revert-protected' ? 0 : o.failureGasUsd;
  if (failureCostUsd > policy.remainingLossBudgetUsd) return { send: false, reason: 'loss-budget-exhausted' };

  const expectedValueUsd = o.winProbability * worstCaseNetUsd - (1 - o.winProbability) * failureCostUsd;
  if (!(expectedValueUsd >= policy.minExpectedValueUsd)) return { send: false, reason: 'negative-expected-value' };

  return { send: true, worstCaseNetUsd, expectedValueUsd };
}
